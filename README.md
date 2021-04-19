# auto-kubernetes-client [![Build Status](https://travis-ci.org/Collaborne/auto-kubernetes-client.svg?branch=master)](https://travis-ci.org/Collaborne/auto-kubernetes-client) [![Greenkeeper badge](https://badges.greenkeeper.io/Collaborne/auto-kubernetes-client.svg)](https://greenkeeper.io/)

NodeJS Kubernetes Client with automatic API discovery.

See this [blog post](https://medium.com/collaborne-engineering/keep-pace-with-kubernetes-nodejs-client-b87a8b175b7b) for further information.

**Note: No more updates expected. We are no longer using this project, if you're interested in taking it over please contact us.**

## Installation

```sh
npm install --save auto-kubernetes-client
```

## Usage

1. Create a configuration object

   ```js
   const config = {
       url: 'https://k8s.example.com',
       ca: 'PEM encoded CA certificate',
       cert: 'PEM encoded client certificate',
       key: 'PEM encoded client key'
   }
   ```

2. Create the client and connect to the API server

   ```js
   const AutoK8sClient = require('auto-kubernetes-client');
   AutoK8sClient(config, function(err, client) {
       if (err) {
           throw new Error(`Error when connecting: ${err.message}`);
       }

       // Use client
   });
   ```

3. Invoke methods

   The client exposes resources available to the authenticated user using a fairly regular API.

   - API groups need to be selected using the `group(name[, version])` method. The "core" API is available
     directly on the `client` instance.
   - Non-namespaced resources are available directly on the API instance (core/group), for namespaced-resources
     one must explicitly select the namespace using the `ns(name)` method.
   - Resource collections are available by their name in plural, for example `client.ns('default').pods` represents
     the "pods" resource collection.
     Resource collections offer resource methods `list`, `watch`, and `deletecollection`, as well as `create` to create a new resource.
   - Single (non-collection) resources are available by their singular name, for example `client.ns('default').pod('pod1')`
     represents the "pod" resources for the "pod1" pod.
     Single resources offer resource methods `get`, `create`, `update`, `patch` and `delete`.
   - Resource methods typically have the signature `method([qs])`, where `qs` is a hash for additional query parameters,
     and return a promise for the parsed response entity.
   - The `watch` resource method has the signature `watch([resourceVersion[, qs]])`, and returns an object stream for the observed changes.
     Each object has a `type` field ('ADDED', 'DELETED', 'MODIFIED', 'ERROR'), and the actual object that was modified.
   - By default the client interprets 'Status' responses from the server with a 'Failure' status as error responses, and translates
     them into actual promise rejections. This can be disabled by using '.options({ rawResponse: true}).resourceMethod(...)' on the resource collection
     or resource.

## Examples

| Example | Description
|---------|------------
|[examples/list-pods](./examples/list-pods)|List all pods in the cluster
|[examples/watch-pods](./examples/watch-pods)|Watch all pods in a specific namespace

## License

    This software is licensed under the Apache 2 license, quoted below.

    Copyright 2017 Collaborne B.V. <http://github.com/Collaborne/>

    Licensed under the Apache License, Version 2.0 (the "License"); you may not
    use this file except in compliance with the License. You may obtain a copy of
    the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
    WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
    License for the specific language governing permissions and limitations under
    the License.
