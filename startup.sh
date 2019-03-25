#! /bin/sh

# Setup timezone
if [ ! -s /etc/timezone ]; then
  echo 'America/Los_Angeles' > /etc/timezone
fi
cp /usr/share/zoneinfo/$(cat /etc/timezone) /etc/localtime

# Start syncing time. Delay this for 60 seconds to give the Minke DNS time to startup.
(sleep 60 ; ntpd -s -f /etc/ntpd.conf) &

# Minke
exec /app/index.js
