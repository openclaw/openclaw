from collections import Counter

# Step 1: BD -> A replacement
t1 = "A QZOT A OEA TR ZIT A FGZZTR A OZT LZKOFU, A FGVOFU OZ VGXSR ZQA T LA OSS ZG XFA FGZ ZIT ZQFUSTR DTLL."

t2 = "OY IT IQR QF NZIOFU EGFYORTFZOQS ZG LQN, IT VKGZT OZ OF EOHITK. ZIOL DTZIGR GY EGDDXFOEQZOGF IQR WTTF HQLLTR RGVF ZG IOD YKGD IOL YQZITK, VIG IQR STQKFTR OZ RXKOFU IOL NTQKL QL Q EGRTWKTA TK OF ZIT VQK. ZIT EOHITK VQL EGDHSTB, Q LTKOTL GY LIOYZOFU STZZTKL QFR LNDWGSL ZIQZ LTTDTR KQFRGD ZG ZIT XFZKQOFTR TNT WXZ VTKT Q DQLZTKHOTET GY SGUOE QFR LZKXEZXKT ZG ZIGLT VIG A FTV ZIT LNLZTD. IT VGXSR LHTFR IGXKL DTZOEXSGXLSN TFEGROFU TQEI DTLLQUT, EQKTYXSSN EKQYZOFU IOL VGKRL ZG YOZ VOZIOF ZIT TFEKNHZTR SQFUXQUT."

combined = t1 + " " + t2

# Key patterns to analyze:
# "ZIT" appears many times - likely "THE"
# "OZ" likely "OF" or "TO"
# "ZG" likely "IN" or "AND"
# "A" is already decoded as "A"
# "T" is very frequent - likely "E" or "T"
# "IT" appears often - if T=E, then "IE" or if T=S, then "IS"

# Let's try T->E, Z->T, I->N, O->F, G->I
# "ZIT" -> "THE" means Z=T, I=H, T=E? No wait...
# If ZIT = THE: Z=T, I=H, T=E
# But T is the most frequent letter... E is most common in English, so T=E makes sense
# But then "IT" with I=H and T=E -> "HE" which appears often, reasonable
# And "OZ" with Z=T -> O?T -> "OT" -> if O=O, then "OT" not common... 
# Let's try: Z=T, I=H, T=E, O=O -> "OZ" = "OT" hmm

# Actually let me think about "IT VKGZT OZ OF EOHITK" 
# If T=E: I? VE?E? TO OF EO?I?EK
# "OZ OF" -> "TO OF"? Then Z=T, O=T? No, can't map two letters to same

# Let me try different approach. Z is very frequent -> E
# T is most frequent -> could be space-related or T

# Key observation: "OZ" appears several times, "ZG" appears several times
# If Z=E: "OE" "EG" - "OF" "IN"? No...
# If Z=E: "O?" and "?G" 

# "BD" was replaced by "A" in step 1
# So original "BD" -> "A"
# The original cipher substituted "a" with "bd"

# Let me try: Z=E, T=T, I=N
# "ZIT" = "ENT"? No
# "ZIT" -> if Z=T, I=H, T=E = "THE" - very likely!
# Then T=E means all T->E
# "IT" with I=H, T=E = "HE"
# "OZ" with Z=T = "O?" 
# "OF" = "O?" too
# If O=O: "OT" and "O?" - hmm "OT" not great
# Wait: "OZ OF" - if Z=T: "OT OF" -> "TO OF"? Then O maps to T and O? 
# That can't work with monoalphabetic substitution.

# Let me reconsider. Maybe ZIT is not "THE"
# What if I=I, T=T: "ZIT" = "ZIT" doesn't help

# Let me try a systematic approach
# "A" is known (was "BD")
# Most common 3-letter words in English: THE, AND, FOR, ARE, BUT, NOT, YOU, ALL
# "ZIT" appears many times - likely "THE" or "AND"
# "OF" appears in "OZ OF" and standalone "OF"

# If ZIT = THE: Z=T, I=H, T=E
# Then "OZ OF" -> T= mapped, O=? Z=T so "O? OF"
# Wait "OF" in ciphertext... if this maps directly, O=O, F=F
# Then "OZ" = "OT" = "TO" (reversed in cipher?)
# No, monoalphabetic is consistent

# If O=O, F=F: "OZ OF EOHITK" -> "O? OF EO?IEK"
# With Z=T: "OT OF EO?IEK" -> "TO OF EO?HEK" 
# "TO OF EOSHEK"? "TO OF ETCHED"? 
# "EHITK" -> "E?HE?" -> with T=E: "E_HE_" -> "EHE_E"
# With K=L: "EHELE"? No...

# Let me try I=S instead of I=H
# ZIT = TSE? No
# I=N: ZIT = TEN? Possible but less common as a word

# OK let me try Z=E
# T=E: conflict! Can't have both Z and T map to E
# So if ZIT is not "THE"...

# Wait, let me reconsider. T is most frequent at 62 occurrences
# In English, E is most common, then T, A, O, I, N, S, H, R
# T=62, Z=48, O=37, F=33, G=33
# So T->E, Z->T, O->A or O, F->O or I or N

# Let's try T->E, Z->T
# "ZIT" -> "T?E" -> "THE" if I->H
# "IT" -> "HE" - good
# "OZ" -> "AT" or "OT"
# "ZG" -> "T?" 
# "OF" -> "?F"

# With T=E, Z=T, I=H, O=A:
# "OZ OF" -> "AT ?F" -> "AT OF" - not great
# "ZG" -> "T?" -> if G=N: "TN" no
# "A FGZZTR" -> "A F?EET?" -> "A STREET" with G=R, F=S, Z=T, T=E, R=Y? "A SWEET?" 
# "A SWEET" -> F=S, G=W, Z=T, T=E, R=? Wait R is already in cipher
# "FGZZTR" -> "SWEET?" -> F=S, G=W, Z=T, Z=T, T=E, R=Y -> "SWEETY"
# Hmm "A SWEET" doesn't make sense as a fragment

# Let me look at t1 more carefully:
# "A QZOT A OEA TR ZIT A FGZZTR A OZT LZKOFU"
# With T=E, Z=T, I=H, F=S, G=W:
# "A Q?A? A OEA ?E THE A SWEET? A O?E L?KOSHU"
# Hmm

# Let me try T=E, Z=T, I=H, O=O, F=F
# "A Q?OT A OEA ?E THE A F?EET? A O?E L?KO?HU"
# "A ?UOT A OEA RE THE A FREE.. A OUE L.SHOU"?
# "A ABOUT A OEA RE THE A FREE.." - "A ABOUT" -> Q=B, Z=T, O=U? No, O can't be both U and O

# OK I think I need to be more careful. Let me focus on the first text:
# "A QZOT A OEA TR ZIT A FGZZTR A OZT LZKOFU, A FGVOFU OZ VGXSR ZQA T LA OSS ZG XFA FGZ ZIT ZQFUSTR DTLL."

# If T=E, Z=T:
# "A Q?E_ A OEA _E THE A _G__E_ A O_E L_KOFU, A _GVOFU O_ VGXSR Z_A E LA OSS _G XF_ _G THE ZQFUSTR _ELL."

# Hmm, let me try T->E, and work from there
# "DTLL" -> "?ELL" -> D=T -> "TELL"! So D=T
# But we already have T->E... D can't also map to T
# Wait, D maps to T and T maps to E. That's fine - different cipher letters map to different plain letters.

# So D=T, T=E
# "DTLL" = "TELL"
# "DTLLQUT" = "TELL_UE" -> Q=L, U=S? "TELLUSE"? "TELL US" with space? Actually "DTLLQUT" -> D=T, T=E, L=L, L=L, Q=U, U=S, T=E -> "TELLUSE"
# Hmm, "DTLLQUT" -> "TELLUSE" doesn't quite work. Maybe Q=U: "TELLU_E" -> "TELLURE"? No.
# With Q=U, U=S: "TELLUSE" -> close but not a word
# Wait: D, T, L, L, Q, U, T -> T, E, L, L, ?, ?, E
# "TELL??" -> "TELL US" doesn't fit 7 chars without space
# Actually "TELLING" would be 7 letters: T-E-L-L-I-N-G
# DTLLQUT -> D=T, T=E, L=L, L=L, Q=I, U=N, T=E -> "TELLINE"? No
# Q=N, U=G? "TELLNGE"? No

# Hmm, let me try T=E, D=T, L=L
# "HQLLTR" -> "_?LLER" -> H=W, Q=I, U=Y? "WILLER"? No, "WILLER" isn't a word
# Or H=F, Q=I, U=Y: "FILLER"? "FILLER"! That could work!
# "QFRGD" -> "I??RT" -> Q=I, F=A, R=N, G=E? But T is already E...
# G can't be E. F=R, R=A? "IRRAD"? No.

# Let me try yet another approach. Focus on "DTLL" = "TELL" (D=T, T=E, L=L confirmed)
# "HQLLTR" = "_?LL_R" 
# "WTTF" = "?__E" with T=E -> "?__E" -> could be "HERE" (W=H, T=E, T=E, F=R)
# Wait W=H, F=R: "H_EER" -> "HEREER"? No, "HERE" is 4 chars, WTTF is 4 chars
# W=H, T=E, T=E, F=R -> "HEER" -> not a word. "WIFE"? No.

# "IT" = "?E" -> with T=E, I=anything + E. Could be "BE", "HE", "ME", "WE", etc.
# If I=I: "IE" no
# I=W: "WE" - very common!

# Let me try T=E, D=T, L=L, W=H (from WTTF="HERE" no...)
# Actually let me try I=N: "NE" appears in text
# "IT" = "NE" - yes! "NE" is common
# But "ZIT" = "?NE" -> Z=T: "TNE"? Not a word. Z=O: "ONE"? 
# Hmm but Z is very frequent (48), "O" in English is also common

# Let me try Z=O: "ZIT" = "ONE" -> Z=O, I=N, T=E
# Then "DTLL" = "TELL" -> D=T, T=E, L=L -> consistent! T=E from both
# "IT" = "NE" - reasonable
# "OZ" = "NO" or "?O" -> O=? -> OZ = "NO" if O=N... but I is already N
# O=O: "OZ" = "OE" not great
# O=A: "OZ" = "AE" not great either

# Let me try O=N, I=O: "ZIT" = "ZOE"? No that doesn't help
# Back to Z=O, I=N, T=E:
# "OZ" -> "N?" -> if Z=O: "NO"? O=N and Z=O: "NO"!
# So O=N, Z=O, I=N? O and I can't both be N

# Let me try Z=T, I=H, T=E (ZIT = THE):
# "DTLL" = "TELL" -> D=T? But Z=T already. Conflict.
# Unless... D isn't T. "DTLL" could be "_ELL" 
# D=F: "FELL"
# D=W: "WELL"
# D=B: "BELL"  
# D=S: "SELL"

# With Z=T, I=H, T=E:
# "HQLLTR" = "?_LL_R" with L=L, T=E: "?_LLER" -> H=F, Q=I, U=Y: "FILLER"? Or H=W, Q=I: "WILLER"? No.
# How about H=B, Q=U, U=Y: "BULLER"? No.
# H=M, Q=U: "MULLER"? That's a name.

# "WTTF" -> "_HHE" -> W=B? "BHHE"? No. 
# W=W, T=E: "W_EE" -> "WEEE"? No.
# W=H: "_HHE" no
# W=W: "WHEE"! Yes!

# "IT" = "HE" -> consistent with I=H, T=E

# "OZ OF" -> "?_ OF" -> Z=T: "?T OF" -> O=A: "AT OF"? No. O=I: "IT OF"? No.
# O=N: "NT OF"? No. 
# Actually "OZ OF" could be part of "OUT OF" or "SORT OF"
# O=S: "ST OF" -> "SORT OF"? That's 2 words...
# "OZ OF EOHITK" -> "S? OF S??HEK"
# Hmm, maybe not.

# Let me try the long text with Z=T, I=H, T=E, L=L, W=W, W=W:
# t2 starts: "OY NH QRQ QF NZNHFU EGQYORTEZOQS ZG LQN, NH VKGZT OZ OF EOHNHK."
# That doesn't look right either.

# Let me try a completely different approach - use word patterns
# "EOHITK" - 6 letters, starts with E, contains T (which is likely E)
# If T=E: "EO_IE_" -> with I=H: "EO_HE_" 
# Hmm this is getting complex. Let me just write a script to try common mappings.

# Actually, let me focus on what I can see:
# T1: "A QZOT A OEA TR ZIT A FGZZTR A OZT LZKOFU"
# With A=A known.
# Pattern: "A _A?A A OEA ?E THE A _G??E? A O?E L?KOFU"

# "A QZOT A" -> "A _A?A A" - this looks like "A CABA A" or similar... 
# Or "A PANIC A"? "A MANIA A"? 
# "A BANANA A"? Q=B, Z=A? But A is already mapped...
# "A PIZZA A"? Q=I, Z=Z, O=A... Z can't be A

# "FGZZTR" with T=E: "_G??E_" -> "SECRET"? F=S, G=E... but T=E already
# "STREET"? F=S, T=E, R=E... T and R both E? No
# "SWEET"? F=S, G=W -> "SWEET" -> F=S, G=W, Z=T, Z=T, T=E, R=? -> R maps to nothing because "SWEET" is 5 letters and "FGZZTR" is 6
# Wait: F-G-Z-Z-T-R = 6 chars, "SWEET" = 5 chars. So "SWEET" doesn't fit.
# "SWEETS"? 6 letters: S-W-E-E-T-S. F=S, G=W, Z=E... but T=E and Z=E conflict
# "STREET" = 6: S-T-R-E-E-T. F=S, G=T... but T=E already. 
# Hmm, actually in the original cipher before step 1, some letters were doubled.

# Wait, I need to reconsider. The cipher uses "BD" to represent "a", so in the ORIGINAL cipher:
# The substitution maps plaintext to ciphertext where "a" → "bd" (two chars)
# All other letters are 1-to-1.

# After reversing BD→A, we have a standard monoalphabetic cipher.
# But wait - if "BD" represents "a", then no other letter maps to "b" or "d" individually.
# Actually no - in a substitution cipher where a→bd, that's unusual. Let me re-read the hint:
# "The second step substitutes 'a' with 'bd'"
# So in the ciphertext, wherever the plaintext had 'a', it was replaced with 'bd'.
# This means 'b' and 'd' in the ciphertext DON'T represent any plaintext letter on their own.
# Wait, that can't be right for a monoalphabetic cipher...

# Actually re-reading: "The first step is a standard mono-character substitution, and the second step substitutes 'a' with 'bd'"
# So the encryption was:
# 1. Apply monoalphabetic substitution to plaintext
# 2. Replace all 'a' in the result with 'bd'

# To decrypt:
# 1. Replace all 'bd' with 'a' (reverse step 2) -- DONE
# 2. Reverse the monoalphabetic substitution

# After step 1, we have standard monoalphabetic text where each letter represents exactly one other letter.
# But 'B' and 'D' in the text are leftover from the original cipher (they were not part of "BD" pairs).

# Actually wait - if after step 1 (BD→A), there's still a "B" in the text (at the end: "VIG A FTV ZIT LNLZTD"), 
# that means this 'B' is a standalone cipher letter, not part of "BD".
# So B and D are valid cipher letters that represent some plaintext letters.

# OK this makes sense now. Let me just focus on frequency analysis and pattern matching.

# Let me try: Z=T, I=H, T=E, L=L, D=T? No, Z=T already.
# D=? "DTLL" = "?ELL" - D could be W (WELL), S (SELL), F (FELL), B (BELL), T (TELL - but Z=T already)

# Key insight: look at "FGZZTR" with T=E, Z=T: F_G_TTE_ -> F_G_TTE_
# Hmm wait Z maps to some letter, and T maps to E.
# If Z=T: F_G_TTE_ -> this has double T in the middle
# Words with double T: "BETTER", "BITTER", "BUTTER", "LATTER", "LETTER", "MATTER", "SETTER"
# "LETTER" = L-E-T-T-E-R -> if Z=T, T=E: L_G_TTE_ -> F=L, G=E... but T=E already.
# "BETTER" = B-E-T-T-E-R -> Z=T, T=E: F_B_TTE_ -> F=B, G=E, R=R? But G can't be E.
# "BUTTER" = B-U-T-T-E-R -> F=B, G=U: "BUTTER" -> F=B, G=U, Z=T, Z=T, T=E, R=R
# Check: B-U-T-T-E-R = FGZZTR. Yes! F=B, G=U, Z=T, Z=T, T=E, R=R!

# Wait but earlier: "HQLLTR" with T=E, L=L, R=R: H?_LLER
# "BULLER"? No. "KILLER"? H=K? 
# Or F=B doesn't work here since F is not in HQLLTR.
# H?_LL_R -> HQLLTR = 6 letters
# If Q=I, U=Y: "KIYLLER"? No
# Actually with L=L: "_?LLER" -> Q=I, U=Y: "_IYLLER"? 
# H=W, Q=I, U=Y: "WILLER"? Not a word
# H=F, Q=I, U=L: "FILLER"? But L is already L. U=L means U and L both map to L. Can't.
# Hmm, unless L→L and U→? 
# Wait: HQLLTR -> H-Q-L-L-T-R
# H=F, Q=U, L=L, L=L, T=E, R=R -> "FULLER"? F-U-L-L-E-R = 6 letters! Yes!
# H=F, Q=U, L=L, T=E, R=R -> "FULLER"

# But wait, FGZZTR = BUTTER requires F=B and G=U, but now I have H=F and Q=U.
# FGZZTR = F-G-Z-Z-T-R. If F=B, G=U, Z=T, T=E, R=R: B-U-T-T-E-R ✓
# HQLLTR = H-Q-L-L-T-R. If H=F, Q=U, L=L, T=E, R=R: F-U-L-L-E-R ✓
# But F=B and H=F? That's fine - different cipher letters.

# Wait but Q=U from HQLLTR and G=U from FGZZTR - Q and G can't both map to U!
# So either HQLLTR ≠ FULLER or FGZZTR ≠ BUTTER.

# Let me reconsider FGZZTR. 
# Other words with pattern _?__E_: 
# Double letter in position 3,4 (after first letter): BETTER, BITTER, LETTER, SETTER, POTTER, MATTER, LATTER, UTTER
# "LETTER" with Z=T, T=E: F_G_TTE_ -> F=L, G=E? T=E conflict
# Actually wait: Z maps to something, T maps to E. "ZZ" in cipher = same letter repeated.
# In "BETTER": E is repeated in positions 3,4. So Z would map to T if BETTER, since T is the repeated letter.
# Hmm no. BETTER = B-E-T-T-E-R. Positions 3,4 are both T. So if ZZ maps to TT, then Z→T.
# And T→E (last letter of BETTER is E).
# FGZZTR = F-G-Z-Z-T-R = B-E-T-T-E-R ✓ (F→B, G→E, Z→T, Z→T, T→E, R→R)
# But G→E and T→E means G and T both map to E. Can't in monoalphabetic!

# So BETTER doesn't work either. Let me think...
# If Z→T and T→E: "FGZZTR" = ?-?-T-T-E-?
# The double Z = double T is fine since Z maps to T.
# ?-?-T-T-E-? where letters 1,2,6 are distinct and different from T,E.
# Words: LITTLE = L-I-T-T-L-E. F→L, G→I, Z→T, T→E, R→L? But F→L and R→L? No.
# SETTLE = S-E-T-T-L-E. F→S, G→E, T→E? G and T both E? No.
# Actually SETTLE: S-E-T-T-L-E. Position 2 is E. So G→E. Position 6 is E. So R→E. G and R both E? No.

# Hmm. In monoalphabetic, each cipher letter maps to exactly one plain letter, and each plain letter maps to exactly one cipher letter.
# So the pattern FGZZTR needs 6 distinct plain letters (since F,G,Z,T,R are all different in cipher... wait are they?)
# F≠G≠Z (yes), Z≠T (yes), T≠R (yes). But what about others?
# F,G,Z,Z,T,R - unique cipher letters: F, G, Z, T, R (5 unique for 6 positions)
# So plain text must have exactly 5 unique letters with one repeated (Z repeats → same plain letter repeats)
# Pattern: A-B-C-C-D-E where A,B,C,D,E are distinct.

# Words matching A-B-C-C-D-E:
# BETTER: B-E-T-T-E-R → unique: B,E,T,R → 4 unique. Pattern: X-Y-Z-Z-Y-W (E repeats at pos 2 and 5). NOT A-B-C-C-D-E
# LETTER: L-E-T-T-E-R → unique: L,E,T,R → 4 unique. Similar issue.
# LITTLE: L-I-T-T-L-E → unique: L,I,T,E → 4 unique. L repeats. NOT matching.
# SETTLE: S-E-T-T-L-E → E repeats at pos 2,6. NOT matching A-B-C-C-D-E.
# BITTER: B-I-T-T-E-R → unique: B,I,T,E,R → 5 unique! And only T repeats at pos 3,4. ✓ Pattern matches!

# BITTER = B-I-T-T-E-R = FGZZTR ✓
# F→B, G→I, Z→T, T→E, R→R

# Now check HQLLTR: H-Q-L-L-T-R
# H=Q-L-L-E-R → 5 cipher letters, L repeats
# Plain: ?-?-?-?-E-R where pos 3,4 same letter
# Words ending in LLER: BALLER, CALLER, FALLER, HALLER, HILLER, KILLER, MILLER, PILLER, TALLER, WALLER
# KILLER: K-I-L-L-E-R → H→K, Q→I, L→L, T→E, R→R ✓ (but G→I already from BITTER!)
# G→I and Q→I conflict!
# TALLER: T-A-L-L-E-R → T→E already, but H→T conflicts
# HALLER: H-A-L-L-E-R → H→H, Q→A, L→L, T→E, R→R ✓ (H=H is unusual but possible)
# Actually H→H means cipher H = plain H. That's fine.
# But "HALLER" isn't a common English word...
# HULLER: H-U-L-L-E-R → H→H, Q→U
# ROLLER: R-O-L-L-E-R → H→R, Q→O. But R→R already from BITTER. H→R conflicts with R→R? No, H→R and R→R means cipher R→plain R, cipher H→plain R. Two different cipher letters mapping to same plain letter R. In monoalphabetic this IS allowed (multiple cipher letters can map to same plain letter... wait no, that's a polyalphabetic then.

# In monoalphabetic cipher, the mapping is bijection: each cipher letter maps to exactly one plain letter, and each plain letter maps to exactly one cipher letter. So H→R and R→R would mean both H and R map to R, which violates bijectivity.

# So ROLLER doesn't work. TALLER: T→E already set (T=E from BITTER). H→T would conflict.
# Let me check what Q could be.
# KILLER needs Q=I, but G=I from BITTER. Conflict.
# MILLER needs Q=I. Same conflict.

# Hmm, maybe BITTER is wrong. Let me reconsider.
# FGZZTR pattern A-B-C-C-D-E with 5 unique letters.
# What about "BOTTLE"? B-O-T-T-L-E → unique: B,O,T,L,E = 5 ✓ Pattern: A-B-C-C-D-E ✓
# F→B, G→O, Z→T, T→E, R→L
# HQLLTR: H-Q-L-L-T-R → H→?-Q→?-L→L-T→E-R→L
# ?-?-L-L-E-L → "BULLER"? H→B, Q→U → B-U-L-L-E-L → 6 chars, 4 unique. ✓ but "BULLER" isn't a word.
# Wait: H-Q-L-L-T-R → H-?-L-L-E-L → "CRAWLER"? No that's 7 letters.
# "CULLER"? C-U-L-L-E-R → H→C, Q→U → but R→L from BOTTLE and R→R? No, R→L.
# ROLLER: R-O-L-L-E-R → H→R, Q→O, but G→O from BOTTLE and Q→O conflict.

# Hmm. Let me try "SETTLE" for FGZZTR: S-E-T-T-L-E
# unique: S,E,T,L = 4 unique. Pattern: A-B-C-C-D-A (E repeats at 2,6). FGZZTR has 5 unique: F,G,Z,T,R
# Doesn't match since SETTLE has only 4 unique and E repeats at non-consecutive positions.
# Wait: S-E-T-T-L-E → cipher: F-G-Z-Z-T-R. S→F, E→G, T→Z, T→Z, L→T, E→R
# E→G and E→R? E maps to both G and R? No, monoalphabetic is bijection. Each letter maps to ONE other letter.

# OK I think the issue is I was wrong about the pattern. Let me re-examine FGZZTR.
# Cipher letters: F, G, Z, Z, T, R
# Unique cipher letters: F, G, Z, T, R (5 unique, Z repeats)
# In plaintext, 5 unique letters with one repeated at positions 3,4.

# The repeated letter (Z) maps to the letter repeated at positions 3,4.
# From ZIT=THE, Z=T. So the repeated letter is T.
# FGZZTR → ?-?-T-T-E-? (with T=E from BITTER analysis)
# Need words: _-_-T-T-E-_ where all _ are distinct and different from T,E.
# UTTER: U-T-T-E-R → G=U, R=R, F=? F needs to be... only 5 letters but we have 6 positions.
# Wait UTTER = U-T-T-E-R is only 5 letters. FGZZTR is 6 letters. So no.
# Unless... the plain text word is 6 letters with TT at pos 3,4.
# MATTER: M-A-T-T-E-R → F→M, G→A, Z→T, T→E, R→R ✓ 6 letters, 5 unique (M,A,T,E,R)
# LATTER: L-A-T-T-E-R → F→L, G→A, Z→T, T→E, R→R ✓
# LETTER: L-E-T-T-E-R → G=E, R=E conflict
# SETTER: S-E-T-T-E-R → same issue
# BETTER: B-E-T-T-E-R → same
# BITTER: B-I-T-T-E-R → F→B, G→I, Z→T, T→E, R→R ✓

# Let me check with ZIT=THE and MATTER for FGZZTR:
# Z=T, I=H, T=E (from THE), F→M, G→A, R→R
# Check HQLLTR: H-Q-L-L-T-R = H-Q-L-L-E-R
# ?-?-L-L-E-R with 5 unique cipher letters
# "CALLER": C-A-L-L-E-R → H→C, Q→A. But G→A from MATTER. Q→A and G→A conflict!
# "HULLER": H-U-L-L-E-R → H→H, Q→U ✓ (no conflict with G→A)
# But HULLER isn't common.
# "TULLER": H→T? But Z→T already. Conflict.
# "BULLER": H→B, Q→U ✓ "BULLER" - not a word
# "FULLER": H→F, Q→U ✓ - not common but possible
# "MULLER": H→M, Q→U. But F→M from MATTER. H→M and F→M conflict.
# "PULLER": H→P, Q→U ✓ - "puller" exists
# "WELLER": H→W, Q→E? T→E already. Q→E conflict.

# With MATTER: F→M, G→A, Z→T, I=H, T=E, R→R
# "LATTER" instead of "MATTER": F→L, G→A
# HQLLTR: H-Q-L-L-E-R → "CALLER" needs Q→A (conflict with G→A)
# "DULLER": H→D, Q→U ✓ (D=H or D=W etc)

# Actually wait, let me look at the FIRST ciphertext more carefully:
# "A QZOT A OEA TR ZIT A FGZZTR A OZT LZKOFU"
# With F→B (BITTER) or F→M (MATTER), G→I or G→A:

# Let me try BITTER: F→B, G→I, Z→T, I=H, T=E, R→R
# "A QZOT A OEA TR ZIT A BITTER A O?T LZKOFU"
# A _?AT A OEA ?E THE A BITTER A O?E L?KOFU
# "A THAT A OEA RE THE A BITTER A OYE L?KOFU"?
# Q→H? But I→H already. 
# Q→T? Z→T already.
# "A QUAT A OEA RE THE" → "A QUOTA A AREA RE THE"? Q→Q, Z→T, O→A: 
# "A Q_AT A OEA" → O→A: "A Q_AT A AEA" - nope, OEA becomes "AEA"? 
# Actually: O→A: "A Q_AT A AEA RE THE A BITTER A A_E L?K_HU"
# Doesn't look right.

# Let me try LATTER: F→L, G→A, Z→T, I=H, T=E, R→R
# "A QZOT A OEA TR ZIT A LATTER A O?T LZKOFU"
# A Q_AT A OEA RE THE A LATTER A O?E L?KOFU
# O→S: "A Q_AT A SEA RE THE A LATTER A SE L?KOFU" -> "A WHAT A SEA" -> Q→W
# "A WHAT A SEA RE THE A LATTER A SE L?KOFU" -> doesn't parse well

# O→O: "A Q?OT A OEA RE THE" 
# O→I: "A Q?IT A IEA RE THE" 
# O→U: "A Q?UT A UEA RE THE"

# Hmm, let me try yet another approach. Look at "A QZOT A"
# This is "A _A_A" or "A _?A_" pattern
# Common phrases: "A PANIC A", "A MANIC A"...
# Q=P, Z=A? But A is A (from BD→A step). Z→A means cipher Z maps to plain A.
# But then ZIT → AHE? Not THE.
# Q=W, Z=O, O=W? No.

# OK what about "A QUOTA A"? Q→Q, Z→O, O→T? No, T→E already set.

# Let me try a completely fresh approach.
# From the hint: "First reverse the 'a'→'bd' substitution (replace all 'BD' with 'A'), then solve the standard monoalphabetic substitution cipher using frequency analysis."

# Combined text after BD→A:
text = "A QZOT A OEA TR ZIT A FGZZTR A OZT LZKOFU, A FGVOFU OZ VGXSR ZQA T LA OSS ZG XFA FGZ ZIT ZQFUSTR DTLL. OY IT IQR QF NZIOFU EGFYORTFZOQS ZG LQN, IT VKGZT OZ OF EOHITK. ZIOL DTZIGR GY EGDDXFOEQZOGF IQR WTTF HQLLTR RGVF ZG IOD YKGD IOL YQZITK, VIG IQR STQKFTR OZ RXKOFU IOL NTQKL QL Q EGRTWKTA TK OF ZIT VQK. ZIT EOHITK VQL EGDHSTB, Q LTKOTL GY LIOYZOFU STZZTKL QFR LNDWGSL ZIQZ LTTDTR KQFRGD ZG ZIT XFZKQOFTR TNT WXZ VTKT Q DQLZTKHOTET GY SGUOE QFR LZKXEZXKT ZG ZIGLT VIG A FTV ZIT LNLZTD. IT VGXSR LHTFR IGXKL DTZOEXSGXLSN TFEGROFU TQEI DTLLQUT, EQKTYXSSN EKQYZOFU IOL VGKRL ZG YOZ VOZIOF ZIT TFEKNHZTR SQFUXQUT."

# Let me count unique cipher letters
import string
cipher_letters = set(c for c in text if c.isalpha())
print(f"Unique cipher letters ({len(cipher_letters)}): {''.join(sorted(cipher_letters))}")

# English letter frequencies (approximate): E T A O I N S H R D L C U M W F G Y P B V K J X Q Z
# Cipher frequencies:
freq = Counter(c for c in text if c.isalpha())
print("\nCipher freq:")
for l, c in freq.most_common():
    print(f"  {l}: {c:3d}  {'█' * (c//2)}")
PYEOF