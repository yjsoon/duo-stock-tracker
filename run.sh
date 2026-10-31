#!/bin/sh
cd /home/box/apple-stock-sg || exit 1
export PATH=/home/box/.local/node/v22/bin:$PATH
pgrep -f "apple-stock-sg/src/index.js" >/dev/null && exit 0
nohup node --env-file-if-exists=.env /home/box/apple-stock-sg/src/index.js >> /home/box/.local/state/apple-stock/apple-stock.log 2>&1 &
echo $! > /home/box/.local/state/apple-stock/pid
