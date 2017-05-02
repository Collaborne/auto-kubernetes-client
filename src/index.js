'use strict';

const request = require('request');
const url = require('url');
const flatMap = require('flatmap');
const through2 = require('through2');

/**
 * Cluster configuration
 *
 * @typedef Configuration
 * @property {string} url
 * @property {boolean} insecureSkipTlsVerify
 * @property {string} ca
 * @property {string} cert
 * @property {string} key
 * @property {ConfigurationAuth} auth
 */
/**
 * Cluster user authentication
 *
 * @typedef ConfigurationAuth
 * @property {string} user
 * @property {string} password
 * @property {string} bearer
 */
/**
 * Client
 *
 * @typedef Client
 */


/**
 * Connect to the cluster
 *
 * @param {Configuration} config
 * @return {Promise<Client>}
 */
module.exports = function connect(config) {
	// Ensure that the config.url ends with a '/'
	const configOptions = Object.assign({}, config, { url: config.url.endsWith('/') ? config.url : config.url + '/' });

	/**
	 * Query the kubernetes server and return a uncooked response stream
	 *
	 * @param {string} path
	 * @param {Object} [extraOptions={}]
	 * @return {Stream}
	 */
	function streamK8sRequest(path, extraOptions = {}) {
		const options = Object.assign({}, configOptions, extraOptions);

		return request(url.resolve(configOptions.url, path), options);
	}

	/**
	 * Query the kubernetes server and return a promise for the result object
	 *
	 * Note that the promise does not reject when a 'Status' object is returned; the caller must apply suitable
	 * checks on its own.
	 *
	 * @param {any} path
	 * @param {any} [extraOptions={}]
	 * @returns {Promise<>}
	 */
	function k8sRequest(path, extraOptions = {}) {
		const options = Object.assign({}, configOptions, { json: true }, extraOptions);

		return new Promise(function(resolve, reject) {
			return request(url.resolve(configOptions.url, path), options, function(err, response, data) {
				if (err) {
					return reject(err);
				} else {
					return resolve(data);
				}
			});
		});
	}

	function createApi(name, groupPath, version, preferred) {
		// Query that API for all possible operations, and map them.
		return k8sRequest(groupPath, {}).then(function(apiResources) {
			// TODO: Transform the API information (APIResourceList) into functions.
			// Basically we have resources[] with each
			// { kind: Bindings, name: bindings, namespaced: true/false }
			// For each of these we want to produce a list/watch function under that name,
			// and a function with that name that returns an object with get/... for the single thing.
			// If namespaced is set then this is appended to the ns() result, otherwise it is directly
			// set on the thing.
			function createResourceCollection(resource, pathPrefix = '') {
				let resourcePath = groupPath + '/';
				if (pathPrefix) {
					resourcePath += pathPrefix + '/';
				}
				resourcePath += resource.name;

				return {
					watch: function(resourceVersion = '', qs = {}) {
						let buffer = Buffer.alloc(0);
						let bufferLength = 0;

						const parseJSONStream = through2.obj(function(chunk, enc, callback) {
							// Find a newline in the buffer: everything up to it together with the current buffer contents is for the callback,
							// and the rest forms the new buffer.
							let newlineIndex;
							let startIndex = 0;
							while ((newlineIndex = chunk.indexOf('\n', startIndex)) !== -1) {
								const contents = Buffer.alloc(bufferLength + newlineIndex - startIndex);
								buffer.copy(contents, 0, 0, bufferLength);
								chunk.copy(contents, bufferLength, startIndex, newlineIndex);
								this.push(JSON.parse(contents.toString('UTF-8')));

								// Clear the buffer if we used it.
								if (bufferLength > 0) {
									bufferLength = 0;
								}

								startIndex = newlineIndex + 1;
							}

							const restData = chunk.slice(startIndex);
							if (bufferLength + restData.length < buffer.length) {
								restData.copy(buffer, bufferLength);
								bufferLength += restData.length;
							} else {
								buffer = bufferLength === 0 ? restData : Buffer.concat([buffer.slice(0, bufferLength), restData]);
								bufferLength = buffer.length;
							}

							return callback();
						}, function(callback) {
							if (bufferLength > 0) {
								this.push(JSON.parse(buffer.toString('UTF-8', 0, bufferLength)));
								bufferLength = 0;
							}

							return callback();
						});

						return streamK8sRequest(resourcePath, { method: 'GET', json: false, qs: Object.assign({}, qs, { watch: 'true', resourceVersion }) })
							.pipe(parseJSONStream);
					},

					list: function(qs = {}) {
						return k8sRequest(resourcePath, { qs, method: 'GET' });
					},

					create: function(object, qs = {}) {
						return k8sRequest(resourcePath, { qs, method: 'POST', body: object });
					},

					deletecollection: function(qs = {}) {
						return k8sRequest(resourcePath, { qs, method: 'DELETE' });
					},
				}
			}

			function createResource(resource, name, pathPrefix = '') {
				let resourcePath = groupPath + '/';
				if (pathPrefix) {
					resourcePath += pathPrefix + '/';
				}
				resourcePath += resource.name + '/';
				resourcePath += name;

				return {
					get: function(qs = {}) {
						return k8sRequest(resourcePath, { qs, method: 'GET' });
					},

					update: function(object, qs = {}) {
						const updateObject = Object.assign({ metadata: { name }}, object);
						return k8sRequest(resourcePath, { qs, method: 'PUT', body: updateObject });
					},

					patch: function(object, qs = {}) {
						return k8sRequest(resourcePath, { qs, method: 'PATCH', body: object });
					},

					delete: function(qs = {}) {
						return k8sRequest(resourcePath, { qs, method: 'DELETE' });
					},
				};
			}

			function createResourceAPI(resource, pathPrefix = '') {
				return {
					[resource.name.toLowerCase()]: createResourceCollection(resource, pathPrefix),
					[resource.kind.toLowerCase()]: function(name) {
						return createResource(resource, name, pathPrefix)
					}
				}
			}

			const nsResources = {};
			const api = {
				name,
				version: version.version,
				preferred,
				ns: function(namespace) {
					// Return adapted nsResources for this namespace
					return Object.keys(nsResources).reduce(function(result, resourceKey) {
						return Object.assign(result, createResourceAPI(nsResources[resourceKey], `namespaces/${namespace}`));
					}, {});
				},

				// other properties here represent non-namespaced resources
			};

			return apiResources.resources.reduce(function(api, resource) {
				const slashIndex = resource.name.indexOf('/');
				if (slashIndex !== -1) {
					const subResource = resource.name.substring(slashIndex + 1);
					switch (subResource) {
					// TODO: Apply suitable additional methods on the resource when we understand the subresource.
					// TODO: support minimally 'status' and possibly 'proxy', 'exec'.
					default:
						// A unknown sub-resource, for now just ignore it.
						console.log(`Found unknown sub-resource ${subResource}, ignoring (${JSON.stringify(resource)})`);
					}
				} else if (resource.namespaced) {
					nsResources[resource.name] = resource;
				} else {
					Object.assign(api, createResourceAPI(resource));
				}
				return api;
			}, api);
		});
	}

	const coreVersion = config.version || 'v1';

	return k8sRequest('apis').then(function(apiGroups) {
		// Initialize the APIs
		const apiPromises = flatMap(apiGroups.groups, function(group) {
			return group.versions.map(version => createApi(group.name, `apis/${version.groupVersion}`, version, version.version === group.preferredVersion.version));
		});
		apiPromises.push(createApi('', `api/${coreVersion}`, { groupVersion: coreVersion, version: coreVersion }, true));
		return Promise.all(apiPromises);
	}).then(function(apis) {
		return apis.reduce(function(result, api) {
			result[api.name] = result[api.name] || {};
			result[api.name][api.version] = api;
			if (api.preferred) {
				result[api.name][''] = api;
			}
			return result;
		}, {})
	}).then(function(apis) {
		const coreApi = Object.assign({}, apis[''][coreVersion]);
		delete coreApi.name;		

		return Object.assign({}, coreApi, {			
			/**
			 * Get the API group with the given name and version
			 *
			 * @param {String} groupName name of the group, may optionally contain a '/version' specification
			 * @param {String} [versionName] version of the group, if not given defaults to the "preferred" version as reported by the server
			 */
			group: function(groupName, versionName) {
				const slashIndex = groupName.indexOf('/');				
				if (slashIndex !== -1) {
					versionName = groupName.substring(slashIndex + 1);
					groupName = groupName.substring(0, slashIndex);
				}

				const apiGroup = apis[groupName];
				if (!apiGroup) {
					// FIXME: APIs might appear later on, we should do a query again here to check
					throw new Error(`No API group ${groupName} available`);
				}

				const api = apiGroup[versionName || ''];
				if (!api) {
					throw new Error(`No version ${versionName} for API group ${groupName} available`);
				}

				return api;
			},
		});
	});
}
