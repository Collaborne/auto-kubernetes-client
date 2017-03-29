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
	const watchPipe = client.ns('master').pods.watch();
	watchPipe.on('data', function(event) {
		console.log(`${event.type} ${event.object.metadata.name}`);
	});
}, function(err) {
	console.error(`Cannot connect to cluster: ${err.message}`);
});
