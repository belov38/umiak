# Systemd container for the guest agent's Linux integration tests (spec S3
# section 21). run.sh starts it privileged with systemd as PID 1, installs
# a dev-signed agent package and runs the integration test binary inside.
# The image follows the template requirements of spec section 20 where a
# container can: user `user` (uid 1000, sudo, linger), sshd on loopback with
# the sbx user CA and the two pam_env lines of section 8.2. No Docker inside.
FROM ubuntu:26.04

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus openssh-server openssh-client e2fsprogs \
      python3 sudo iproute2 curl ca-certificates util-linux procps \
 && rm -rf /var/lib/apt/lists/*

# The image's default uid 1000 is "ubuntu"; the template's is "user".
# Ubuntu's skeleton ~/.bash_logout runs clear_console, which writes ESC[3J
# to stdout and "TERM environment variable not set." to stderr when a login
# shell (`bash -lc`, the default of agent shell commands) ends with `exit`:
# command output would not be byte-exact. The template must drop it (a
# proposed S5 requirement, see the Task 18 report).
RUN userdel -r ubuntu 2>/dev/null || true \
 && useradd -m -u 1000 -s /bin/bash -G sudo user \
 && rm -f /home/user/.bash_logout /root/.bash_logout \
 && echo 'user ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-sbx-user \
 && chmod 0440 /etc/sudoers.d/90-sbx-user \
 && mkdir -p /var/lib/systemd/linger && touch /var/lib/systemd/linger/user

# sshd per spec section 20: loopback only, no passwords, the sbx user CA.
RUN mkdir -p /etc/sbx /etc/sbx-agent \
 && : > /etc/sbx/env \
 && : > /etc/sbx-agent/ssh-user-ca.pub \
 && : > /etc/ssh/sbx_user_ca.pub \
 && printf '%s\n' \
      'ListenAddress 127.0.0.1' \
      'ListenAddress ::1' \
      'PasswordAuthentication no' \
      'KbdInteractiveAuthentication no' \
      'TrustedUserCAKeys /etc/ssh/sbx_user_ca.pub' \
      > /etc/ssh/sshd_config.d/50-sbx.conf \
 && printf '%s\n' \
      'session required pam_env.so readenv=1 envfile=/etc/sbx/env' \
      'session required pam_env.so readenv=1 envfile=/run/sbx/secrets/env' \
      >> /etc/pam.d/sshd \
 && rm -f /etc/ssh/ssh_host_* \
 && systemctl enable ssh.service

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
