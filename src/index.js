const request = require('request');
const url = require('url');
const flatMap = require('flatmap');
const through2 = require('through2');
const deepMerge = require('deepmerge');

const {calculateApiName} = require('./utils');

/**
 * Cluster configuration
 *
 * @typedef Configuration
 * @property {string} url
 * @property {string} [version='v1'] requested API version for the "core" group
 * @property {boolean} [rejectUnauthorized=false]
 * @property {string} [ca]
 * @property {string} [cert]
 * @property {string} [key]
 * @property {string} [token]
 * @property {ConfigurationAuth} [auth]
 */
/**
 * Cluster user authentication
 *
 * @typedef ConfigurationAuth
 * @property {string} [user]
 * @property {string} [password]
 * @property {string} [bearer]
 */
/**
 * Client
 *
 * @typedef Client
 */


/**
 * Connect to the cluster
 *
 * @param {Configuration} config client configuration
 * @return {Promise<Client>} a promise that resolves to a connected client
 */
function connect(config) {
	const {token, ...otherConfig} = config;
	let authConfig = {};
	if (token) {
		authConfig = {
			auth: {
				bearer: token,
			},
		};
	}
	// Ensure that the config.url ends with a '/'
	const configOptions = Object.assign({}, otherConfig, {
		url: config.url.endsWith('/') ? config.url : `${config.url}/`,
	}, authConfig);

	/**
	 * Query the kubernetes server and return a uncooked response stream
	 *
	 * @param {string} path path to query, relative to the API server URL
	 * @param {Object} [extraOptions={}] additional options for use with `request`
	 * @return {Request} a stream of the query results
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
	 * @param {string} path path to query, relative to the API server URL
	 * @param {Object} [extraOptions={}] additional options for use with `request`
	 * @returns {Promise<Object>} a promise that resolves to the result of the query
	 */
	function k8sRequest(path, extraOptions = {}) {
		const cooked = !extraOptions.rawResponse;
		const options = Object.assign({}, configOptions, {json: true}, extraOptions);

		return new Promise((resolve, reject) => {
			return request(url.resolve(configOptions.url, path), options, (err, response, data) => {
				if (err) {
					return reject(err);
				}

				if (cooked) {
					let maybeStatus;
					if (typeof data === 'string') {
						// The server doesn't (always?) produce a Status for 401/403 errors it seems.
						// It should according to https://github.com/kubernetes/community/blob/master/contributors/devel/api-conventions.md#http-status-codes,
						// but likely the authentication/authorization layer prevents that.
						// See https://github.com/kubernetes/kubernetes/issues/45970
						maybeStatus = {
							apiVersion: 'v1',
							code: response.statusCode,
							kind: 'Status',
							message: data,
							metadata: {},
							reason: response.statusMessage,
							status: 'Failure',
						};
					} else {
						maybeStatus = data;
					}

					if (maybeStatus.kind === 'Status' && maybeStatus.status === 'Failure') {
						// Synthesize an error from the status
						return reject(Object.assign(maybeStatus, new Error(maybeStatus.message)));
					}
				}
				return resolve(data);
			});
		});
	}

	function createApi(apiName, groupPath, version, preferred) { // eslint-disable-line max-params
		// Query that API for all possible operations, and map them.
		function createApiFromResources(apiResources) {
			// TODO: Transform the API information (APIResourceList) into functions.
			// Basically we have resources[] with each
			// { kind: Bindings, name: bindings, namespaced: true/false }
			// For each of these we want to produce a list/watch function under that name,
			// and a function with that name that returns an object with get/... for the single thing.
			// If namespaced is set then this is appended to the ns() result, otherwise it is directly
			// set on the thing.
			function createResourceCollection(resource, pathPrefix = '', extraOptions = {}) {
				let resourcePath = `${groupPath}/`;
				if (pathPrefix) {
					resourcePath += `${pathPrefix}/`;
				}
				resourcePath += resource.name;

				return {
					options(options) {
						return createResourceCollection(resource, pathPrefix, Object.assign({}, extraOptions, options));
					},

					watch(resourceVersion = '', qs = {}) {
						let buffer = Buffer.alloc(0);
						let bufferLength = 0;

						const parseJSONStream = through2.obj((chunk, enc, callback) => {
							// Find a newline in the buffer: everything up to it together with the current buffer contents is for the callback,
							// and the rest forms the new buffer.
							let newlineIndex;
							let startIndex = 0;
							while ((newlineIndex = chunk.indexOf('\n', startIndex)) !== -1) {
								const contents = Buffer.alloc(bufferLength + newlineIndex - startIndex);
								buffer.copy(contents, 0, 0, bufferLength);
								chunk.copy(contents, bufferLength, startIndex, newlineIndex);
								parseJSONStream.push(JSON.parse(contents.toString('UTF-8')));

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
						}, callback => {
							if (bufferLength > 0) {
								parseJSONStream.push(JSON.parse(buffer.toString('UTF-8', 0, bufferLength)));
								bufferLength = 0;
							}

							return callback();
						});

						return streamK8sRequest(resourcePath, Object.assign({}, extraOptions, {
							json: false,
							method: 'GET',
							qs: Object.assign({}, qs, {
								resourceVersion,
								watch: 'true',
							})
						}))
							.pipe(parseJSONStream);
					},

					list(qs = {}) {
						return k8sRequest(resourcePath, Object.assign({}, extraOptions, {
							method: 'GET',
							qs,
						}));
					},

					create(object, qs = {}) {
						return k8sRequest(resourcePath, Object.assign({}, extraOptions, {
							body: object,
							method: 'POST',
							qs,
						}));
					},

					deletecollection(qs = {}) {
						return k8sRequest(resourcePath, Object.assign({}, extraOptions, {
							method: 'DELETE',
							qs,
						}));
					},
				};
			}

			function createResource(resource, name, pathPrefix = '', extraOptions = {}) { // eslint-disable-line max-params
				let resourcePath = `${groupPath}/`;
				if (pathPrefix) {
					resourcePath += `${pathPrefix}/`;
				}
				resourcePath += `${resource.name}/`;
				resourcePath += name;

				return {
					options(options) {
						return createResource(resource, name, pathPrefix, Object.assign({}, extraOptions, options));
					},

					get(qs = {}) {
						return k8sRequest(resourcePath, Object.assign({}, extraOptions, {
							method: 'GET',
							qs,
						}));
					},

					create(object, qs = {}) {
						const createObject = deepMerge({metadata: {name}}, object);

						// Creating happens by posting to the list:
						let listPath = `${groupPath}/`;
						if (pathPrefix) {
							listPath += `${pathPrefix}/`;
						}
						listPath += resource.name;

						return k8sRequest(listPath, Object.assign({}, extraOptions, {
							body: createObject,
							method: 'POST',
							qs,
						}));
					},

					update(object, qs = {}) {
						const updateObject = deepMerge({metadata: {name}}, object);
						return k8sRequest(resourcePath, Object.assign({}, extraOptions, {
							body: updateObject,
							method: 'PUT',
							qs,
						}));
					},

					/**
					 * Patch the resource.
					 *
					 * The 'contentType' parameter describes how to process the given object:
					 * 'application/strategic-merge-patch+json': (default) object is a partial representation
					 * 'application/merge-patch+json': RFC7386 "Merge Patch"
					 * 'application/json-patch+json': RFC6902 "JSON Patch" (object is an array of operations to apply)
					 *
					 * See https://github.com/kubernetes/community/blob/master/contributors/devel/api-conventions.md#patch-operations for details.
					 *
					 * Note that not all resources support all patch content types, and an error 415 with a reason "UnsupportedMediaType" may get returned
					 * in that case.
					 *
					 * @param {any} object the patch to apply
					 * @param {String} [contentType] the content type
					 * @param {Object} [qs] additional query parameters
					 * @return {Promise<Object>} promise that resolves to the response of the request
					 */
					patch(object, contentType = 'application/strategic-merge-patch+json', qs = {}) {
						// Handle cases where qs is given but not contentType
						let realQS;
						let realContentType;
						if (typeof contentType === 'object') {
							realQS = contentType;
							realContentType = 'application/strategic-merge-patch+json';
						} else {
							realQS = qs;
							realContentType = contentType;
						}

						return k8sRequest(resourcePath, Object.assign({}, extraOptions, {
							body: object,
							headers: {'content-type': realContentType},
							method: 'PATCH',
							qs: realQS,
						}));
					},

					delete(qs = {}) {
						return k8sRequest(resourcePath, Object.assign({}, extraOptions, {
							method: 'DELETE',
							qs,
						}));
					},
				};
			}

			function createResourceAPI(resource, pathPrefix = '') {
				return {
					[resource.name.toLowerCase()]: createResourceCollection(resource, pathPrefix),
					[resource.kind.toLowerCase()]: resourceName => createResource(resource, resourceName, pathPrefix)
				};
			}

			const nsResources = {};
			const api = {
				name: apiName,
				preferred,
				version: version.version,
				// Other properties here represent non-namespaced resources
			};

			api.ns = namespace => {
				// Return adapted nsResources for this namespace
				return Object.keys(nsResources).reduce((result, resourceKey) => {
					return Object.assign(result, createResourceAPI(nsResources[resourceKey], `namespaces/${namespace}`));
				}, {});
			};

			/**
			 * Get information about the resource with the given kind
			 *
			 * @param {String} kind
			 */
			// XXX: Should this instead exist on the collection or on the single resource via an 'info'/'explain' method?
			api.resource = kind => {
				return apiResources.resources.find(resource => kind === resource.kind);
			};


			return apiResources.resources.reduce((targetApi, resource) => {
				const slashIndex = resource.name.indexOf('/');
				if (slashIndex !== -1) {
					const subResource = resource.name.substring(slashIndex + 1);
					switch (subResource) {
					// TODO: Apply suitable additional methods on the resource when we understand the subresource.
					// TODO: support minimally 'status' and possibly 'proxy', 'exec'.
					default:
						// A unknown sub-resource, for now just ignore it.
					}
				} else if (resource.namespaced) {
					nsResources[resource.name] = resource;
				} else {
					Object.assign(targetApi, createResourceAPI(resource));
				}
				return targetApi;
			}, api);
		}

		return k8sRequest(groupPath, {}).then(createApiFromResources);
	}

	const coreVersion = config.version || 'v1';

	return k8sRequest('apis').then(apiGroups => {
		// Initialize the APIs
		const apiPromises = flatMap(apiGroups.groups, group => {
			return group.versions.map(version => createApi(group.name, `apis/${version.groupVersion}`, version, version.version === group.preferredVersion.version));
		});
		apiPromises.push(createApi('', `api/${coreVersion}`, {
			groupVersion: coreVersion,
			version: coreVersion
		}, true));
		return Promise.all(apiPromises);
	}).then(apis => {
		return apis.reduce((result, api) => {
			// Build a compatible name for this API. Note that both api.name and api.version can end up empty here.
			const apiNamePrefix = api.name ? `${api.name}/` : '';
			result[`${apiNamePrefix}${api.version}`] = api;
			if (api.preferred) {
				result[api.name] = api;
			}
			return result;
		}, {});
	}).then(apis => {
		const coreApi = Object.assign({}, apis[coreVersion]);
		// Remove the 'name' field from the root object
		delete coreApi.name;

		return Object.assign({}, coreApi, {

			/**
			 * Get the API group with the given name and version
			 *
			 * @param {string} groupName name of the group, may optionally contain a '/version' specification
			 * @param {string} [versionName] version of the group, if not given defaults to the "preferred" version as reported by the server
			 * @return {Object} an API for the given group
			 * @throws {Error} when no API group is available with that name (and version)
			 */
			group(groupName, versionName) {
				const apiName = calculateApiName(groupName, versionName);
				const api = apis[apiName];
				if (!api) {
					// FIXME: APIs might appear later on, we should do a query again here to check
					throw new Error(`No API group ${apiName} available`);
				}

				return api;
			},
		});
	});
}

module.exports = connect;
