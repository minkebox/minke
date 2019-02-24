#! /bin/sh

# Setup timezone
if [ ! -s /etc/timezone ]; then
  echo 'America/Los_Angeles' > /etc/timezone
fi
cp /usr/share/zoneinfo/$(cat /etc/timezone) /etc/localtime

# Start syncing time
ntpd -s -f /etc/ntpd.conf

# Go
exec /app/index.js
