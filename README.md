# VSC Node

< fill in >

## Installation

### Docker compose

Install [Docker](https://docs.docker.com/get-docker/) and [Docker compose](https://docs.docker.com/compose/install/).

Download the Docker compose file [here](https://raw.githubusercontent.com/vsc-eco/vsc-node/main/deploy/docker-compose/docker-compose.yml).

Assure that the Docker user has write permissions in the directory you startup the Docker compose file.

Create an `.env` file according to the schema specified in the [.env.example](https://raw.githubusercontent.com/vsc-eco/vsc-node/main/.env.example) file and put it next to the docker compose file.

``` txt
# Fill these in with your hive account details
HIVE_ACCOUNT=
HIVE_ACCOUNT_POSTING=
HIVE_ACCOUNT_ACTIVE=


# Leave untouched unless instructed otherwise.
MULTISIG_ACCOUNT=vsc.beta
MULTISIG_ANTI_HACK=did:key:z6Mkj5mKz5EBnqqsyV2qBohYFuvTXpCuxzNMGSpa1FJRstze
MULTISIG_ANTI_HACK_KEY=
```

Launch via `docker-compose up -d`.

### Ansible

Ansible is a [deployment automation](https://opensource.com/resources/what-ansible) tool.

You can install the VSC node via an ansible playbook. [Follow the instructions](https://docs.ansible.com/ansible/latest/installation_guide/intro_installation.html#pip-install) to install ansible on your machine. Sshpass is also a requirement (`apt install sshpass`). Note: it is only available on linux (you can also use it in WSL).

The installation has been tested on **ubuntu**.

To use the supplied ansible script you will need to define a target node. This can be done by creating an `inventory.yml` file and dropping it in the root of this project. 
```yml
---
vsc_nodes:
  hosts:
    raspberrypi:
      ansible_host: 192.168.0.100           #changeme
      ansible_user: pi                      #changeme
      ansible_password: <mypassword>        #changeme
      ansible_become_pass: <mypassword>     #changeme

```

The ansible playbook can then be launched via the command shown below.

`ansible-playbook deploy/ansible/docker_install/playbook.yml -i inventory.yml`

You will be prompted for various hive keys that need to be entered in order for your node to function properly. 

Note: the last step of the script takes really long for the first time as it needs to fetch node modules. If you wanna check if your node is actively doing something check the `top` command.

On a high level the script 

1. installs docker and its prequesites
1. copies over relevant files
1. starts up the docker-compose file to launch the node
1. register the update.sh script as a crown job to automatically keep the node up to date

The bare_metal installation is currently not completed.
