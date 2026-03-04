from poly_eip712_structs import make_domain
from eth_utils import keccak
from py_order_utils.utils import prepend_zx

from .model import ClobAuth
from ..signer import Signer

CLOB_DOMAIN_NAME = "ClobAuthDomain"
CLOB_VERSION = "1"
MSG_TO_SIGN = "This message attests that I control the given wallet"


def get_clob_auth_domain(chain_id: int):
    return make_domain(name=CLOB_DOMAIN_NAME, version=CLOB_VERSION, chainId=chain_id)


def sign_clob_auth_message(signer: Signer, timestamp: int, nonce: int) -> str:
    clob_auth_msg = ClobAuth(
        address=signer.address(),
        timestamp=str(timestamp),
        nonce=nonce,
        message=MSG_TO_SIGN,
    )
    chain_id = signer.get_chain_id()
    auth_struct_hash = prepend_zx(
        keccak(clob_auth_msg.signable_bytes(get_clob_auth_domain(chain_id))).hex()
    )
    return prepend_zx(signer.sign(auth_struct_hash))
