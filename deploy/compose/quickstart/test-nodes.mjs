// Injected node-service double for legacy wizard tests; core uses real PostgreSQL tests.
export const testNodes = {
	installerNodeRetired: async () => false,
	select: async (state, id) => {
		const local = state.steps.limits?.data?.nodeId;
		if (id && local && id !== local) throw Error("Unknown sandbox node");
		return structuredClone(state);
	},
	list: async (_, state) =>
		state?.steps?.connection
			? [
					{
						nodeId: state.steps.limits?.data?.nodeId,
						name: state.steps.connection.data.node,
						state: "active",
					},
				]
			: [],
	reserve: async () => {},
	interrupt: async () => {},
	finish: async () => {},
	registerTemplate: async () => ({ id: "new-build" }),
};
