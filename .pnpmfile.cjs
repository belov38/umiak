// openapi-typescript (@sbx/sdk codegen) needs the TypeScript JS API; TypeScript 7
// ships none. Give it its own TypeScript 5 instead of the workspace peer.
module.exports = {
	hooks: {
		readPackage(pkg) {
			if (pkg.name === "openapi-typescript") {
				delete pkg.peerDependencies?.typescript;
				pkg.dependencies = { ...pkg.dependencies, typescript: "5.9.3" };
			}
			return pkg;
		},
	},
};
