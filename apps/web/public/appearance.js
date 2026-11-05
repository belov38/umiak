(() => {
	let saved;
	try {
		saved = localStorage.getItem("umiak-theme");
	} catch {}
	document.documentElement.classList.toggle(
		"dark",
		saved
			? saved === "dark"
			: matchMedia("(prefers-color-scheme: dark)").matches,
	);
})();
