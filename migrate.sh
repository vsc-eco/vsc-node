#!/bin/bash

repo_url="https://github.com/vsc-eco/vsc-deployment.git"
default_path=$(realpath "../")

if [ -z "$1" ]; then
    echo "VSC node migration script. The default path is for the deployment repository is '${default_path}'"
    read -p "Enter the path to clone the repository [${default_path}]: " clone_path
    clone_path="${clone_path:-$default_path}"
else
    clone_path="$1"
fi

clone_path=$clone_path"/vsc-deployment"

mkdir -p "$clone_path" || { echo "Failed to create directory at ${clone_path}"; exit 1; }

git clone "$repo_url" "$clone_path" || { echo "Failed to clone repository."; exit 1; }

# Check if the .env file and data directory do not exist in the target and do exist in the current directory
if [ ! -f "${clone_path}/.env" ] && [ ! -d "${clone_path}/data" ] && [ -f ".env" ] && [ -d "data" ]; then
    cp ".env" "${clone_path}/"
    cp -r "data" "${clone_path}/"
    echo "Node data copied successfully."
else
    echo "Node data not found in the current directory or already exists in the target directory."
    exit 1
fi

echo "Migration completed successfully."
echo "Please use the vsc-deployment repository to launch the node from now on."