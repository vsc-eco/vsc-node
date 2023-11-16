#!/bin/bash
set -e

updateCode=$(git pull);

gitCommit=$(git rev-parse HEAD)


# if [[ "$updateCode" == "Already up to date." ]]
# then
#   echo $updateCode
#   exit
# fi
{ # try

    deployedGitCommit=`cat data/git-flag`
    #save your output

} || { # catch
    deployedGitCommit="0"
}
echo "$gitCommit $deployedGitCommit"

indexVersion=`cat deploy/index-flag`
{ # try

    indexVersionDeployed=`cat data/index-flag`
    #save your output

} || { # catch
    indexVersionDeployed="0"
}
echo "$indexVersion $indexVersionDeployed"

if [ "$gitCommit" != "$deployedGitCommit" ];
then
  docker-compose down

  sleep 15; # Ensure safe shutdown

  docker-compose build


  if [ "$indexVersion" -ne "$indexVersionDeployed" ];
  then
    echo "Need to reset database"
    { # try
      rm -r data/*
    } || { # catch
        indexVersionDeployed="0"
    }
    
    echo $indexVersion > data/index-flag
  fi


  docker-compose up -d

  echo $deployedGitCommit > data/git-flag
fi

