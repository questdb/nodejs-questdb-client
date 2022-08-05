#!/bin/bash
if test $# -ne 2
then
    echo "Wrong number of arguments"
    echo "Usage: generateCerts.sh <ROOTPATH> <PASSWORD>"
    exit 1
fi

ROOTPATH="$1"
PASSWORD=$2
RSABITS=4096

# make directories to work from
mkdir -p $ROOTPATH/certs/{server,client,ca}

PATH_CA=$ROOTPATH/certs/ca
PATH_SERVER=$ROOTPATH/certs/server
PATH_CLIENT=$ROOTPATH/certs/client

######
# CA #
######

# Generate CA key
openssl genrsa -des3 -passout pass:$PASSWORD -out $PATH_CA/ca.key $RSABITS

# Create CA cert
openssl req -new -x509 -days 3650 -key $PATH_CA/ca.key -out $PATH_CA/ca.crt -passin pass:$PASSWORD -subj "/C=GB/ST=EN/L=./O=QUEST CA/CN=QUEST"

##########
# SERVER #
##########

# Generate server key
openssl genrsa -out $PATH_SERVER/server.key $RSABITS

# Generate server cert
openssl req -new -key $PATH_SERVER/server.key -out $PATH_SERVER/server.csr -passout pass:$PASSWORD -subj "/C=GB/ST=EN/L=./O=QUEST SERVER/CN=localhost" \
      -reqexts SAN -extensions SAN -config <(cat /etc/ssl/openssl.cnf <(printf "[SAN]\nsubjectAltName=DNS:localhost,IP:127.0.0.1"))

# Sign server cert with CA
openssl x509 -req -days 3650 -set_serial 01 \
      -extfile <(printf "subjectAltName=DNS:localhost,IP:127.0.0.1") \
      -passin pass:$PASSWORD -in $PATH_SERVER/server.csr -CA $PATH_CA/ca.crt -CAkey $PATH_CA/ca.key -out $PATH_SERVER/server.crt

##########
# CLIENT #
##########

# Generate client key
openssl genrsa -out $PATH_CLIENT/client.key $RSABITS

# Generate client cert
openssl req -new -key $PATH_CLIENT/client.key -out $PATH_CLIENT/client.csr -passout pass:$PASSWORD -subj "/C=GB/ST=EN/L=./O=QUEST CLIENT/CN=CLIENT"

# Sign client cert with CA
openssl x509 -req -days 3650 -set_serial 01 \
      -passin pass:$PASSWORD -in $PATH_CLIENT/client.csr -CA $PATH_CA/ca.crt -CAkey $PATH_CA/ca.key -out $PATH_CLIENT/client.crt

exit 0
