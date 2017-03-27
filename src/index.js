'use strict';

const request = require('request');
const url = require('url');
const flatMap = require('flatmap');

/**
 * Query the kubernetes server
 *
 * @param {string} path
 * @param {Object} [extraOptions={}]
 * @param {Function} [callback=null]
 */
function doRequest(config, path, extraOptions = {}, callback = null) {
	const options = Object.assign({}, config, {
		json: true
	}, extraOptions)

	return request(url.resolve(config.url, path), options, callback);
}

function wrapCallback(callback) {
	return function(err, response, result) {
		if (err) {
			// Basic error
			return callback(err, response, result);
		} else if (result && result.apiVersion === 'v1' && result.kind === 'Status' && result.status === 'Failure') {
			// k8s error encoded as status
			return callback(new Error(result.message), response, result);
		} else {
			return callback(null, response, result);
		}
	}
}

module.exports = function connect(config, callback) {
	// Ensure that the config.url ends with a '/'
	const k8sRequest = doRequest.bind(this, Object.assign({}, config, { url: config.url.endsWith('/') ? config.url : config.url + '/' }));

	k8sRequest('apis', {}, function(err, response, apiGroups) {
		function _createApi(groupPath, groupVersion) {
			// Query that API for all possible operations, and map them.
			return new Promise(function(resolve, reject) {
				return k8sRequest(groupPath, {}, wrapCallback(function(err, response, apiResources) {
					if (err) {
						return reject(err);
					}

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
							watch: function(callback, resourceVersion = '', qs = {}) {
								// Watch calls the callback for each item, so we're switching off JSON mode, and instead
								// process each line of the response separately
								// Buffer contains usable data from 0..bufferLength
								let buffer = Buffer.alloc(0);
								let bufferLength = 0;
								return k8sRequest(resourcePath, { method: 'GET', json: false, qs: Object.assign({}, qs, { watch: 'true', resourceVersion }) })
									.on('error', function(err) {
										return callback(err);
									})
									.on('data', function(data) {
										// Find a newline in the buffer: everything up to it together with the current buffer contents is for the callback,
										// and the rest forms the new buffer.
										let newlineIndex;
										let startIndex = 0;
										while ((newlineIndex = data.indexOf('\n', startIndex)) !== -1) {
											const contents = Buffer.alloc(bufferLength + newlineIndex - startIndex);
											buffer.copy(contents, 0, 0, bufferLength);
											data.copy(contents, bufferLength, startIndex, newlineIndex);
											callback(null, JSON.parse(contents.toString('UTF-8')));

											// Clear the buffer if we used it.
											if (bufferLength > 0) {
												bufferLength = 0;
											}

											startIndex = newlineIndex + 1;
										}

										const restData = data.slice(startIndex);
										if (bufferLength + restData.length < buffer.length) {
											restData.copy(buffer, bufferLength);
											bufferLength += restData.length;
										} else {
											buffer = bufferLength === 0 ? restData : Buffer.concat([buffer.slice(0, bufferLength), restData]);
											bufferLength = buffer.length;
										}
									})
									.on('end', function() {
										if (bufferLength > 0) {
											callback(JSON.parse(buffer.toString('UTF-8', 0, bufferLength)));
										}

										return callback(null, null);
									});
							},

							list: function(callback, qs = {}) {
								return k8sRequest(resourcePath, { qs, method: 'GET' }, wrapCallback(callback));
							},

							deletecollection: function(callback, qs = {}) {
								return k8sRequest(resourcePath, { qs, method: 'DELETE' }, wrapCallback(callback));
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
							get: function(callback, qs = {}) {
								return k8sRequest(resourcePath, { qs, method: 'GET' }, wrapCallback(callback));
							},

							create: function(object, callback, qs = {}) {
								return k8sRequest(resourcePath, { qs, method: 'POST', body: object }, wrapCallback(callback));
							},

							update: function(object, callback, qs = {}) {
								return k8sRequest(resourcePath, { qs, method: 'PUT', body: object }, wrapCallback(callback));
							},

							patch: function(object, callback, qs = {}) {
								return k8sRequest(resourcePath, { qs, method: 'PATCH', body: object }, wrapCallback(callback));
							},

							delete: function(callback, qs = {}) {
								return k8sRequest(resourcePath, { qs, method: 'DELETE' }, wrapCallback(callback));
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
						name: groupVersion,
						ns: function(namespace) {
							// Return adapted nsResources for this namespace
							return Object.keys(nsResources).reduce(function(result, resourceKey) {
								return Object.assign(result, createResourceAPI(nsResources[resourceKey], `namespaces/${namespace}`));
							}, {});
						},

						// other properties here represent non-namespaced resources
					};

					apiResources.resources.forEach(function(resource) {
						const slashIndex = resource.name.indexOf('/');
						if (slashIndex !== -1) {
							const subResource = resource.name.substring(slashIndex + 1);
							switch (subResource) {
							// TODO: Apply suitable additional methods on the resource when we understand the subresource.
							// TODO: support minimally 'status' and possibly 'proxy', 'exec'.
							default:
								// A unknown sub-resource, for now just ignore it.
								console.log(`Found unknown sub-resource ${subResource}, ignoring (${JSON.stringify(resource)})`);
								return;
							}
						}
						if (resource.namespaced) {
							nsResources[resource.name] = resource;
						} else {
							Object.assign(api, createResourceAPI(resource));
						}
					});

					return resolve(api);
				}));
			});
		}

		function _resolveVersion(groupName, versionName) {
			const group = apiGroups.groups.find(group => group.name === groupName);
			if (!group) {
				throw new Error(`No API group ${groupName} available`);
			}
			const version = versionName ? group.versions.find(version => version.version === versionName) : group.preferredVersion;
			if (!version) {
				throw new Error(`No version ${versionName} for API group ${groupName} available`);
			}

			return version;
		}

		if (err) {
			return callback(err, null);
		}
		
		// Initialize the APIs
		const apis = {};
		function _loadApi(groupPath, version) {
			return _createApi(groupPath, version.groupVersion).then(function(api) {
				apis[api.name || ''] = api;
				return api;
			});
		}

		const _createPromises = flatMap(apiGroups.groups, function(group) {
			return group.versions.map(version => _loadApi(`apis/${version.groupVersion}`, version));
		});
		const coreVersion = config.version || 'v1';
		const corePath = `api/${coreVersion}`;
		_createPromises.push(_loadApi(corePath, coreVersion));

		return Promise.all(_createPromises).then(function() {
			const coreApi = Object.assign({}, apis['']);
			delete coreApi.name;

			return callback(null, Object.assign({}, coreApi, {
				_request: k8sRequest,
				_apiGroups: apiGroups,
				group: function(groupName, versionName) {
					const version = _resolveVersion(groupName, versionName);

					const api = apis[version.groupVersion];
					if (!api) {
						throw new Error(`Unknown group ${groupName}/${versionName}`);
					}

					return api;
				},
			}));
		}, function(error) {
			return callback(error);
		})
	});
}
