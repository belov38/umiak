# Systemd container for the guest agent's Linux integration tests. Run it
# privileged with systemd as PID 1 (see run.sh in Task 18).
FROM ubuntu:26.04

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus \
 && rm -rf /var/lib/apt/lists/*

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
