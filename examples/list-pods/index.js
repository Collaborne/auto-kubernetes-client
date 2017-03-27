'use strict';

const fs = require('fs');
const path = require('path');

const K8sClient = require('.');

const userDir = process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];
const config = {
	url: 'https://192.168.99.100:8443',
	ca: fs.readFileSync(path.resolve(userDir, '.minikube/ca.crt'), 'UTF-8'),
	cert: fs.readFileSync(path.resolve(userDir, '.minikube/apiserver.crt'), 'UTF-8'),
	key: fs.readFileSync(path.resolve(userDir, '.minikube/apiserver.key'), 'UTF-8')
};

K8sClient(config, function(err, client) {
	if (err) {
		console.error(`Cannot connect to cluster: ${err.message}`);
		return;
	}

	client.namespaces.list(function(err, response, nsList) {
		if (err) {
			console.error(`Cannot list namespaces: ${err.message}`);
			return;
		}

		return nsList.items.forEach(function(ns) {
			return client.ns(ns.metadata.name).pods.list(function(err, response, podList) {
				podList.items.forEach(function(pod) {
					console.log(`Discovered pod ${pod.metadata.namespace}/${pod.metadata.name}`);
				});
			});
		});
	});
});
