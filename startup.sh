#! /bin/sh

# Setup timezone
if [ "${TZ}" != "" ]; then
  echo ${TZ} > /etc/timezone
fi
if [ ! -e /etc/timezone ]; then
  echo 'America/Los_Angeles' > /etc/timezone
fi
cp /usr/share/zoneinfo/$(cat /etc/timezone) /etc/localtime

# Start syncing time. Delay this for 60 seconds to give the MinkeBox DNS time to startup.
echo "servers pool.ntp.org" > /etc/ntpd.conf
(sleep 60 ; ntpd -s -f /etc/ntpd.conf) &

# Use our own DNS
echo "nameserver 127.0.0.1" > /etc/resolv.conf

# MinkeBox
trap "killall node" INT TERM
/usr/bin/node --expose-gc /app/index.js &
wait "$!"
wait "$!"

# Restart if testing (so we can debug inside the docker container)
while [ -f /tmp/minke-testing ]; do
  /usr/bin/node --expose-gc /app/index.js
done
