#!/bin/bash
set -e

echo "********** This method of updating the node is deprecated.                  **********"
echo "********** Please use the vsc-deployment repository to launch the VSC-node. **********"
echo "********** For an easy migration please use the 'migrate.sh' script.        **********"

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

  echo $gitCommit > data/git-flag
fi

