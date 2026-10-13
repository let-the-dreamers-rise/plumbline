"""TEST ONLY. Mints a fresh throwaway TDX PCK chain (root -> PCK platform CA -> PCK leaf) exactly as
zk/fixtures/make_synthetic_quote.py does, but keeps the PCK leaf key so the e2e dstack stub can sign
new quotes later. Writes into <out-dir>:
  test-root.der    the root the e2e copy of the test-root guest pins
  pck-key.pem      PCK leaf private key (throwaway, never leaves the e2e work dir)
  pck-chain.pem    leaf, CA, root (PEM), as embedded in the quote's certification data
The repo's fixtures/test-root.der is not touched: its private key was never saved, so no new quote can
chain to it.

    python3 mint_test_root.py <out-dir>"""
import os, sys, datetime
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec


def name(cn):
    return x509.Name([x509.NameAttribute(NameOID.ORGANIZATION_NAME, 'Tessera TEST ONLY'), x509.NameAttribute(NameOID.COMMON_NAME, cn)])


def cert(subject, subject_key, issuer, issuer_key, ca):
    now = datetime.datetime(2026, 1, 1)
    b = (x509.CertificateBuilder().subject_name(name(subject)).issuer_name(name(issuer))
         .public_key(subject_key.public_key()).serial_number(x509.random_serial_number())
         .not_valid_before(now).not_valid_after(now + datetime.timedelta(days=3650))
         .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True))
    return b.sign(issuer_key, hashes.SHA256())


def main(out):
    os.makedirs(out, exist_ok=True)
    root_k, ca_k, pck_k = (ec.generate_private_key(ec.SECP256R1()) for _ in range(3))
    root = cert('Test Root CA', root_k, 'Test Root CA', root_k, True)
    ca = cert('Test PCK Platform CA', ca_k, 'Test Root CA', root_k, True)
    pck = cert('Test PCK Certificate', pck_k, 'Test PCK Platform CA', ca_k, False)
    open(os.path.join(out, 'test-root.der'), 'wb').write(root.public_bytes(serialization.Encoding.DER))
    open(os.path.join(out, 'pck-chain.pem'), 'wb').write(b''.join(c.public_bytes(serialization.Encoding.PEM) for c in (pck, ca, root)))
    fd = os.open(os.path.join(out, 'pck-key.pem'), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.write(fd, pck_k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    os.close(fd)


if __name__ == '__main__':
    main(sys.argv[1])
