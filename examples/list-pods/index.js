'use strict';

const fs = require('fs');
const path = require('path');

const K8sClient = require('../..');

const userDir = process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'];
const config = {
	url: 'https://192.168.99.100:8443',
	ca: fs.readFileSync(path.resolve(userDir, '.minikube/ca.crt'), 'UTF-8'),
	cert: fs.readFileSync(path.resolve(userDir, '.minikube/apiserver.crt'), 'UTF-8'),
	key: fs.readFileSync(path.resolve(userDir, '.minikube/apiserver.key'), 'UTF-8')
};

K8sClient(config).then(function(client) {
	return client.namespaces.list()
		.then(nsList => nsList.items.map(ns => client.ns(ns.metadata.name).pods.list()))
		.then(podListPromises => Promise.all(podListPromises))
		.then(podLists => podLists.reduce((result, podList) => result.concat(podList.items), []))
		.then(pods => pods.forEach(pod => console.log(`Discovered pod ${pod.metadata.namespace}/${pod.metadata.name}`)));
}).catch(function(err) {
	console.error(`Error: ${err.message}`);
});
