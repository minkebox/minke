#! /bin/sh

# Setup timezone
cp /usr/share/zoneinfo/$(cat /etc/timezone) /etc/localtime

# Go
exec /app/index.js
