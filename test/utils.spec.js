const {expect} = require('chai');
const {describe, it} = require('mocha');

const {calculateApiName} = require('../src/utils');

describe('utils', () => {
	describe('calculateApiName', () => {
		it('joins group name and version name if no slash', () => {
			expect(calculateApiName('foo', 'v1')).to.be.equals('foo/v1');
		});
		it('uses group name with slash', () => {
			expect(calculateApiName('foo/v1')).to.be.equals('foo/v1');
		});
		it('prefers version name', () => {
			expect(calculateApiName('foo/v1', 'v2')).to.be.equals('foo/v2');
		});
		it('handles an empty group name if version is given', () => {
			expect(calculateApiName('', 'v1')).to.be.equals('v1');
		});
		it('handles an empty group name if version is not given', () => {
			expect(calculateApiName('')).to.be.equals('');
		});
	});
});
