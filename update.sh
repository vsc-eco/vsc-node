#!/bin/bash
set -e

updateCode=$(git pull);

if [[ "$updateCode" == "Already up to date." ]]
then
  echo $updateCode
  exit
fi

indexVersion=`cat deploy/index-flag`
{ # try

    indexVersionDeployed=`cat data/index-flag`
    #save your output

} || { # catch
    indexVersionDeployed="0"
}
echo "$indexVersion $indexVersionDeployed"

docker-compose down

sleep 15; # Ensure safe shutdown

docker-compose build


if [ "$indexVersion" -ne "$indexVersionDeployed" ];
then 
  echo "Need to reset database"
  rm -r data/*
  echo $indexVersion > data/index-flag
fi


docker-compose up -d