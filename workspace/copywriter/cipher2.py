from collections import Counter

text = "A QZOT A OEA TR ZIT A FGZZTR A OZT LZKOFU, A FGVOFU OZ VGXSR ZQA T LA OSS ZG XFA FGZ ZIT ZQFUSTR DTLL. OY IT IQR QF NZIOFU EGFYORTFZOQS ZG LQN, IT VKGZT OZ OF EOHITK. ZIOL DTZIGR GY EGDDXFOEQZOGF IQR WTTF HQLLTR RGVF ZG IOD YKGD IOL YQZITK, VIG IQR STQKFTR OZ RXKOFU IOL NTQKL QL Q EGRTWKTA TK OF ZIT VQK. ZIT EOHITK VQL EGDHSTB, Q LTKOTL GY LIOYZOFU STZZTKL QFR LNDWGSL ZIQZ LTTDTR KQFRGD ZG ZIT XFZKQOFTR TNT WXZ VTKT Q DQLZTKHOTET GY SGUOE QFR LZKXEZXKT ZG ZIGLT VIG A FTV ZIT LNLZTD. IT VGXSR LHTFR IGXKL DTZOEXSGXLSN TFEGROFU TQEI DTLLQUT, EQKTYXSSN EKQYZOFU IOL VGKRL ZG YOZ VOZIOF ZIT TFEKNHZTR SQFUXQUT."

# Try T->E, Z->T (ZIT = THE)
# Then I->H (THE = ZIT -> Z=T, I=H, T=E)
mapping = {
    'T': 'E',
    'Z': 'T', 
    'I': 'H',
}

# Let's also try: FGZZTR = BITTER -> F=B, G=I (but I->H already... let me try F=B, G=O)
# No wait, BITTER = B-I-T-T-E-R, so if Z=T and T=E: F->B, G->I, Z->T, T->E, R->R
# But I->H from ZIT=THE, and G->I from BITTER. Conflict? No, I(cipher)->H(plain) and G(cipher)->I(plain) is fine.

mapping['F'] = 'B'
mapping['G'] = 'O'  # Let me try G->O for BOTTLE instead
# mapping['G'] = 'I'  # For BITTER
mapping['R'] = 'L'  # For BOTTLE

# Actually let me try BOTTLE: B-O-T-T-L-E -> FGZZTR
# F->B, G->O, Z->T, T->E, R->L
# But wait BOTTLE = B O T T L E (6 letters), FGZZTR (6 letters) ✓
# And T->E (position 6 is E) is consistent with our mapping!

mapping = {
    'T': 'E',
    'Z': 'T',
    'I': 'H', 
    'F': 'B',
    'G': 'O',
    'R': 'L',
}

# Now let's see what HQLLTR becomes
# H-Q-L-L-T-R = H-Q-L-L-E-L with T->E
# Words ending in LLER: KILLER, MILLER, PILLER, FILLER, etc.
# But L(cipher)->L(plain)? Let me try L->I
# Actually wait, in BOTTLE, we have L as plain text. So cipher R->L.
# What about L(cipher)? Not used in BOTTLE.

# HQLLTR with T->E: ?-?-?-?-E-L
# If L->L: ?-?-L-L-E-L -> need 6 letter word ending LEL... not common
# If L->? 

# Let me try with the mapping and see what patterns emerge
def decrypt(cipher, mapping):
    result = ""
    for c in cipher:
        if c in mapping:
            result += mapping[c]
        elif c.isalpha():
            result += c.lower()  # unmapped stays lowercase
        else:
            result += c
    return result

print("Partial decrypt with T->E, Z->T, I->H, F->B, G->O, R->L:")
print(decrypt(text, mapping))
print()

# Look at patterns
# "ZIT" = "THE" ✓
# "FGZZTR" = "BOTTLE" -> "BOTTEL"? Wait let me check: F-G-Z-Z-T-R = B-O-T-T-E-L ✓
# "A FGZZTR A" = "A BOTTLE A"? Doesn't make sense.
# Maybe FGZZTR = LITTLE? L-I-T-T-L-E
# F->L, G->I, Z->T, Z->T, T->E, R->L
# But F->L and R->L? Two cipher letters to same plain letter? No, monoalphabetic is bijection.

# Hmm, let me try FGZZTR = BITTER: B-I-T-T-E-R
# F->B, G->I, Z->T, T->E, R->R
mapping = {
    'T': 'E',
    'Z': 'T',
    'I': 'H',
    'F': 'B', 
    'G': 'I',
    'R': 'R',
}
print("With FGZZTR = BITTER:")
print(decrypt(text, mapping))
PYEOF