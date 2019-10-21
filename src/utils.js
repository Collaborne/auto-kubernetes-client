function calculateApiName(groupName, versionName) {
	// Calculate a full API name from groupName and version name.

	let apiName;
	const slashIndex = groupName.indexOf('/');
	if (slashIndex === -1) {
		if (groupName) {
			apiName = versionName ? `${groupName}/${versionName}` : groupName;
		} else {
			apiName = versionName || '';
		}
	} else if (versionName) {
		// Version given in both the groupName and as parameters, use the one from the parameter.
		const realGroupName = groupName.substring(0, slashIndex);
		apiName = `${realGroupName}/${versionName}`;
	} else {
		apiName = groupName;
	}

	return apiName;
}

module.exports = {
	calculateApiName,
};
