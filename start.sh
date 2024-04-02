#!/bin/bash
npm install --legacy-peer-deps &&
if [ "$DEV" == "true" ]; then
  npm run dev
else
  npm run build &&
  npm run start
fi