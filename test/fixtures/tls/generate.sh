#!/bin/sh
# Erzeugt die TLS-Testfixtures neu (nur für Entwicklung, OpenSSL ≥ 3.4).
# ÖFFENTLICHE DEMO-SCHLÜSSEL: Nur für die Tests, nirgends sonst vertrauen.
# Gültigkeit 2000–9999, damit die Tests nicht von der Uhrzeit abhängen.
set -eu
cd "$(dirname "$0")"
DAYS='-not_before 20000101000000Z -not_after 99991231235959Z'
CURVE='-newkey ec -pkeyopt ec_paramgen_curve:P-256'

# Test-CA
openssl req -x509 $CURVE -nodes -keyout ca.key -out ca.pem $DAYS \
  -subj '/CN=ai-proxy Test-CA (oeffentlich, nur Tests)' \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign'

# Serverzertifikat für 127.0.0.1/localhost und eines für einen fremden Hostnamen
issue() {
  openssl req $CURVE -nodes -keyout "$1.key" -out "$1.csr" -subj "/CN=$2"
  openssl x509 -req -in "$1.csr" -CA ca.pem -CAkey ca.key -out "$1.pem" $DAYS \
    -extfile /dev/stdin <<EXT
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=$3
EXT
  rm "$1.csr"
}
issue server '127.0.0.1' 'IP:127.0.0.1,DNS:localhost'
issue wronghost 'wrong.example' 'DNS:wrong.example'

# Eine zweite, unbeteiligte CA (gültiges PEM, aber falscher Vertrauensanker)
openssl req -x509 $CURVE -nodes -keyout other-ca.key -out other-ca.pem $DAYS \
  -subj '/CN=ai-proxy andere Test-CA' -addext 'basicConstraints=critical,CA:TRUE'
rm ca.key other-ca.key
