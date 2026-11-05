# Archived entry point from 21c0e169 (before updater bridge ecacd544).
# Intentionally unchanged: regression documents unsupported minUpdater metadata.
def run_update(runner, current, bundle, *, ui, state_path, sleep):
    backend = HostBackend(runner, current, bundle, ui=ui, state_path=state_path, sleep=sleep)
    record = transaction(backend)
    if record["status"] != "updated":
        raise InstallerError("Update failed; previous release restored. See update history.")
    return backend.result

