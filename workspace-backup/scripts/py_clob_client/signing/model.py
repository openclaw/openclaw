from poly_eip712_structs import EIP712Struct, Address, String, Uint


class ClobAuth(EIP712Struct):
    address = Address()
    timestamp = String()
    nonce = Uint()
    message = String()
