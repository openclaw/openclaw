######################## BEGIN LICENSE BLOCK ########################
# The Original Code is mozilla.org code.
#
# The Initial Developer of the Original Code is
# Netscape Communications Corporation.
# Portions created by the Initial Developer are Copyright (C) 1998
# the Initial Developer. All Rights Reserved.
#
# Contributor(s):
#   Mark Pilgrim - port to Python
#
# This library is free software; you can redistribute it and/or
# modify it under the terms of the GNU Lesser General Public
# License as published by the Free Software Foundation; either
# version 2.1 of the License, or (at your option) any later version.
#
# This library is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
# Lesser General Public License for more details.
#
# You should have received a copy of the GNU Lesser General Public
# License along with this library; if not, write to the Free Software
# Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA
# 02110-1301  USA
######################### END LICENSE BLOCK #########################

from .codingstatemachinedict import CodingStateMachineDict
from .enums import MachineState

# BIG5

# fmt: off
BIG5_CLS = (
    1, 1, 1, 1, 1, 1, 1, 1,  # 00 - 07    #allow 0x00 as legal value
    1, 1, 1, 1, 1, 1, 0, 0,  # 08 - 0f
    1, 1, 1, 1, 1, 1, 1, 1,  # 10 - 17
    1, 1, 1, 0, 1, 1, 1, 1,  # 18 - 1f
    1, 1, 1, 1, 1, 1, 1, 1,  # 20 - 27
    1, 1, 1, 1, 1, 1, 1, 1,  # 28 - 2f
    1, 1, 1, 1, 1, 1, 1, 1,  # 30 - 37
    1, 1, 1, 1, 1, 1, 1, 1,  # 38 - 3f
    2, 2, 2, 2, 2, 2, 2, 2,  # 40 - 47
    2, 2, 2, 2, 2, 2, 2, 2,  # 48 - 4f
    2, 2, 2, 2, 2, 2, 2, 2,  # 50 - 57
    2, 2, 2, 2, 2, 2, 2, 2,  # 58 - 5f
    2, 2, 2, 2, 2, 2, 2, 2,  # 60 - 67
    2, 2, 2, 2, 2, 2, 2, 2,  # 68 - 6f
    2, 2, 2, 2, 2, 2, 2, 2,  # 70 - 77
    2, 2, 2, 2, 2, 2, 2, 1,  # 78 - 7f
    4, 4, 4, 4, 4, 4, 4, 4,  # 80 - 87
    4, 4, 4, 4, 4, 4, 4, 4,  # 88 - 8f
    4, 4, 4, 4, 4, 4, 4, 4,  # 90 - 97
    4, 4, 4, 4, 4, 4, 4, 4,  # 98 - 9f
    4, 3, 3, 3, 3, 3, 3, 3,  # a0 - a7
    3, 3, 3, 3, 3, 3, 3, 3,  # a8 - af
    3, 3, 3, 3, 3, 3, 3, 3,  # b0 - b7
    3, 3, 3, 3, 3, 3, 3, 3,  # b8 - bf
    3, 3, 3, 3, 3, 3, 3, 3,  # c0 - c7
    3, 3, 3, 3, 3, 3, 3, 3,  # c8 - cf
    3, 3, 3, 3, 3, 3, 3, 3,  # d0 - d7
    3, 3, 3, 3, 3, 3, 3, 3,  # d8 - df
    3, 3, 3, 3, 3, 3, 3, 3,  # e0 - e7
    3, 3, 3, 3, 3, 3, 3, 3,  # e8 - ef
    3, 3, 3, 3, 3, 3, 3, 3,  # f0 - f7
    3, 3, 3, 3, 3, 3, 3, 0  # f8 - ff
)

BIG5_ST = (
    MachineState.ERROR,MachineState.START,MachineState.START,     3,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,#00-07
    MachineState.ERROR,MachineState.ERROR,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ERROR,#08-0f
    MachineState.ERROR,MachineState.START,MachineState.START,MachineState.START,MachineState.START,MachineState.START,MachineState.START,MachineState.START#10-17
)
# fmt: on

BIG5_CHAR_LEN_TABLE = (0, 1, 1, 2, 0)

BIG5_SM_MODEL: CodingStateMachineDict = {
    "class_table": BIG5_CLS,
    "class_factor": 5,
    "state_table": BIG5_ST,
    "char_len_table": BIG5_CHAR_LEN_TABLE,
    "name": "Big5",
}

# CP949
# fmt: off
CP949_CLS  = (
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0,  # 00 - 0f
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1,  # 10 - 1f
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,  # 20 - 2f
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,  # 30 - 3f
    1, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,  # 40 - 4f
    4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 1, 1, 1, 1, 1,  # 50 - 5f
    1, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,  # 60 - 6f
    5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 1, 1, 1, 1, 1,  # 70 - 7f
    0, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,  # 80 - 8f
    6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,  # 90 - 9f
    6, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 8, 8, 8,  # a0 - af
    7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,  # b0 - bf
    7, 7, 7, 7, 7, 7, 9, 2, 2, 3, 2, 2, 2, 2, 2, 2,  # c0 - cf
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,  # d0 - df
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,  # e0 - ef
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 0,  # f0 - ff
)

CP949_ST = (
#cls=    0      1      2      3      4      5      6      7      8      9  # previous state =
    MachineState.ERROR,MachineState.START,     3,MachineState.ERROR,MachineState.START,MachineState.START,     4,     5,MachineState.ERROR,     6, # MachineState.START
    MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR, # MachineState.ERROR
    MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME, # MachineState.ITS_ME
    MachineState.ERROR,MachineState.ERROR,MachineState.START,MachineState.START,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.START,MachineState.START,MachineState.START, # 3
    MachineState.ERROR,MachineState.ERROR,MachineState.START,MachineState.START,MachineState.START,MachineState.START,MachineState.START,MachineState.START,MachineState.START,MachineState.START, # 4
    MachineState.ERROR,MachineState.START,MachineState.START,MachineState.START,MachineState.START,MachineState.START,MachineState.START,MachineState.START,MachineState.START,MachineState.START, # 5
    MachineState.ERROR,MachineState.START,MachineState.START,MachineState.START,MachineState.START,MachineState.ERROR,MachineState.ERROR,MachineState.START,MachineState.START,MachineState.START, # 6
)
# fmt: on

CP949_CHAR_LEN_TABLE = (0, 1, 2, 0, 1, 1, 2, 2, 0, 2)

CP949_SM_MODEL: CodingStateMachineDict = {
    "class_table": CP949_CLS,
    "class_factor": 10,
    "state_table": CP949_ST,
    "char_len_table": CP949_CHAR_LEN_TABLE,
    "name": "CP949",
}

# EUC-JP
# fmt: off
EUCJP_CLS = (
    4, 4, 4, 4, 4, 4, 4, 4,  # 00 - 07
    4, 4, 4, 4, 4, 4, 5, 5,  # 08 - 0f
    4, 4, 4, 4, 4, 4, 4, 4,  # 10 - 17
    4, 4, 4, 5, 4, 4, 4, 4,  # 18 - 1f
    4, 4, 4, 4, 4, 4, 4, 4,  # 20 - 27
    4, 4, 4, 4, 4, 4, 4, 4,  # 28 - 2f
    4, 4, 4, 4, 4, 4, 4, 4,  # 30 - 37
    4, 4, 4, 4, 4, 4, 4, 4,  # 38 - 3f
    4, 4, 4, 4, 4, 4, 4, 4,  # 40 - 47
    4, 4, 4, 4, 4, 4, 4, 4,  # 48 - 4f
    4, 4, 4, 4, 4, 4, 4, 4,  # 50 - 57
    4, 4, 4, 4, 4, 4, 4, 4,  # 58 - 5f
    4, 4, 4, 4, 4, 4, 4, 4,  # 60 - 67
    4, 4, 4, 4, 4, 4, 4, 4,  # 68 - 6f
    4, 4, 4, 4, 4, 4, 4, 4,  # 70 - 77
    4, 4, 4, 4, 4, 4, 4, 4,  # 78 - 7f
    5, 5, 5, 5, 5, 5, 5, 5,  # 80 - 87
    5, 5, 5, 5, 5, 5, 1, 3,  # 88 - 8f
    5, 5, 5, 5, 5, 5, 5, 5,  # 90 - 97
    5, 5, 5, 5, 5, 5, 5, 5,  # 98 - 9f
    5, 2, 2, 2, 2, 2, 2, 2,  # a0 - a7
    2, 2, 2, 2, 2, 2, 2, 2,  # a8 - af
    2, 2, 2, 2, 2, 2, 2, 2,  # b0 - b7
    2, 2, 2, 2, 2, 2, 2, 2,  # b8 - bf
    2, 2, 2, 2, 2, 2, 2, 2,  # c0 - c7
    2, 2, 2, 2, 2, 2, 2, 2,  # c8 - cf
    2, 2, 2, 2, 2, 2, 2, 2,  # d0 - d7
    2, 2, 2, 2, 2, 2, 2, 2,  # d8 - df
    0, 0, 0, 0, 0, 0, 0, 0,  # e0 - e7
    0, 0, 0, 0, 0, 0, 0, 0,  # e8 - ef
    0, 0, 0, 0, 0, 0, 0, 0,  # f0 - f7
    0, 0, 0, 0, 0, 0, 0, 5  # f8 - ff
)

EUCJP_ST = (
          3,     4,     3,     5,MachineState.START,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,#00-07
     MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,#08-0f
     MachineState.ITS_ME,MachineState.ITS_ME,MachineState.START,MachineState.ERROR,MachineState.START,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,#10-17
     MachineState.ERROR,MachineState.ERROR,MachineState.START,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,     3,MachineState.ERROR,#18-1f
          3,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.START,MachineState.START,MachineState.START,MachineState.START#20-27
)
# fmt: on

EUCJP_CHAR_LEN_TABLE = (2, 2, 2, 3, 1, 0)

EUCJP_SM_MODEL: CodingStateMachineDict = {
    "class_table": EUCJP_CLS,
    "class_factor": 6,
    "state_table": EUCJP_ST,
    "char_len_table": EUCJP_CHAR_LEN_TABLE,
    "name": "EUC-JP",
}

# EUC-KR
# fmt: off
EUCKR_CLS  = (
    1, 1, 1, 1, 1, 1, 1, 1,  # 00 - 07
    1, 1, 1, 1, 1, 1, 0, 0,  # 08 - 0f
    1, 1, 1, 1, 1, 1, 1, 1,  # 10 - 17
    1, 1, 1, 0, 1, 1, 1, 1,  # 18 - 1f
    1, 1, 1, 1, 1, 1, 1, 1,  # 20 - 27
    1, 1, 1, 1, 1, 1, 1, 1,  # 28 - 2f
    1, 1, 1, 1, 1, 1, 1, 1,  # 30 - 37
    1, 1, 1, 1, 1, 1, 1, 1,  # 38 - 3f
    1, 1, 1, 1, 1, 1, 1, 1,  # 40 - 47
    1, 1, 1, 1, 1, 1, 1, 1,  # 48 - 4f
    1, 1, 1, 1, 1, 1, 1, 1,  # 50 - 57
    1, 1, 1, 1, 1, 1, 1, 1,  # 58 - 5f
    1, 1, 1, 1, 1, 1, 1, 1,  # 60 - 67
    1, 1, 1, 1, 1, 1, 1, 1,  # 68 - 6f
    1, 1, 1, 1, 1, 1, 1, 1,  # 70 - 77
    1, 1, 1, 1, 1, 1, 1, 1,  # 78 - 7f
    0, 0, 0, 0, 0, 0, 0, 0,  # 80 - 87
    0, 0, 0, 0, 0, 0, 0, 0,  # 88 - 8f
    0, 0, 0, 0, 0, 0, 0, 0,  # 90 - 97
    0, 0, 0, 0, 0, 0, 0, 0,  # 98 - 9f
    0, 2, 2, 2, 2, 2, 2, 2,  # a0 - a7
    2, 2, 2, 2, 2, 3, 3, 3,  # a8 - af
    2, 2, 2, 2, 2, 2, 2, 2,  # b0 - b7
    2, 2, 2, 2, 2, 2, 2, 2,  # b8 - bf
    2, 2, 2, 2, 2, 2, 2, 2,  # c0 - c7
    2, 3, 2, 2, 2, 2, 2, 2,  # c8 - cf
    2, 2, 2, 2, 2, 2, 2, 2,  # d0 - d7
    2, 2, 2, 2, 2, 2, 2, 2,  # d8 - df
    2, 2, 2, 2, 2, 2, 2, 2,  # e0 - e7
    2, 2, 2, 2, 2, 2, 2, 2,  # e8 - ef
    2, 2, 2, 2, 2, 2, 2, 2,  # f0 - f7
    2, 2, 2, 2, 2, 2, 2, 0   # f8 - ff
)

EUCKR_ST = (
    MachineState.ERROR,MachineState.START,     3,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,#00-07
    MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ERROR,MachineState.ERROR,MachineState.START,MachineState.START #08-0f
)
# fmt: on

EUCKR_CHAR_LEN_TABLE = (0, 1, 2, 0)

EUCKR_SM_MODEL: CodingStateMachineDict = {
    "class_table": EUCKR_CLS,
    "class_factor": 4,
    "state_table": EUCKR_ST,
    "char_len_table": EUCKR_CHAR_LEN_TABLE,
    "name": "EUC-KR",
}

# JOHAB
# fmt: off
JOHAB_CLS = (
    4,4,4,4,4,4,4,4,  # 00 - 07
    4,4,4,4,4,4,0,0,  # 08 - 0f
    4,4,4,4,4,4,4,4,  # 10 - 17
    4,4,4,0,4,4,4,4,  # 18 - 1f
    4,4,4,4,4,4,4,4,  # 20 - 27
    4,4,4,4,4,4,4,4,  # 28 - 2f
    4,3,3,3,3,3,3,3,  # 30 - 37
    3,3,3,3,3,3,3,3,  # 38 - 3f
    3,1,1,1,1,1,1,1,  # 40 - 47
    1,1,1,1,1,1,1,1,  # 48 - 4f
    1,1,1,1,1,1,1,1,  # 50 - 57
    1,1,1,1,1,1,1,1,  # 58 - 5f
    1,1,1,1,1,1,1,1,  # 60 - 67
    1,1,1,1,1,1,1,1,  # 68 - 6f
    1,1,1,1,1,1,1,1,  # 70 - 77
    1,1,1,1,1,1,1,2,  # 78 - 7f
    6,6,6,6,8,8,8,8,  # 80 - 87
    8,8,8,8,8,8,8,8,  # 88 - 8f
    8,7,7,7,7,7,7,7,  # 90 - 97
    7,7,7,7,7,7,7,7,  # 98 - 9f
    7,7,7,7,7,7,7,7,  # a0 - a7
    7,7,7,7,7,7,7,7,  # a8 - af
    7,7,7,7,7,7,7,7,  # b0 - b7
    7,7,7,7,7,7,7,7,  # b8 - bf
    7,7,7,7,7,7,7,7,  # c0 - c7
    7,7,7,7,7,7,7,7,  # c8 - cf
    7,7,7,7,5,5,5,5,  # d0 - d7
    5,9,9,9,9,9,9,5,  # d8 - df
    9,9,9,9,9,9,9,9,  # e0 - e7
    9,9,9,9,9,9,9,9,  # e8 - ef
    9,9,9,9,9,9,9,9,  # f0 - f7
    9,9,5,5,5,5,5,0   # f8 - ff
)

JOHAB_ST = (
# cls = 0                   1                   2                   3                   4                   5                   6                   7                   8                   9
    MachineState.ERROR ,MachineState.START ,MachineState.START ,MachineState.START ,MachineState.START ,MachineState.ERROR ,MachineState.ERROR ,3                  ,3                  ,4                  ,  # MachineState.START
    MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,  # MachineState.ITS_ME
    MachineState.ERROR ,MachineState.ERROR ,MachineState.ERROR ,MachineState.ERROR ,MachineState.ERROR ,MachineState.ERROR ,MachineState.ERROR ,MachineState.ERROR ,MachineState.ERROR ,MachineState.ERROR ,  # MachineState.ERROR
    MachineState.ERROR ,MachineState.START ,MachineState.START ,MachineState.ERROR ,MachineState.ERROR ,MachineState.START ,MachineState.START ,MachineState.START ,MachineState.START ,MachineState.START ,  # 3
    MachineState.ERROR ,MachineState.START ,MachineState.ERROR ,MachineState.START ,MachineState.ERROR ,MachineState.START ,MachineState.ERROR ,MachineState.START ,MachineState.ERROR ,MachineState.START ,  # 4
)
# fmt: on

JOHAB_CHAR_LEN_TABLE = (0, 1, 1, 1, 1, 0, 0, 2, 2, 2)

JOHAB_SM_MODEL: CodingStateMachineDict = {
    "class_table": JOHAB_CLS,
    "class_factor": 10,
    "state_table": JOHAB_ST,
    "char_len_table": JOHAB_CHAR_LEN_TABLE,
    "name": "Johab",
}

# EUC-TW
# fmt: off
EUCTW_CLS = (
    2, 2, 2, 2, 2, 2, 2, 2,  # 00 - 07
    2, 2, 2, 2, 2, 2, 0, 0,  # 08 - 0f
    2, 2, 2, 2, 2, 2, 2, 2,  # 10 - 17
    2, 2, 2, 0, 2, 2, 2, 2,  # 18 - 1f
    2, 2, 2, 2, 2, 2, 2, 2,  # 20 - 27
    2, 2, 2, 2, 2, 2, 2, 2,  # 28 - 2f
    2, 2, 2, 2, 2, 2, 2, 2,  # 30 - 37
    2, 2, 2, 2, 2, 2, 2, 2,  # 38 - 3f
    2, 2, 2, 2, 2, 2, 2, 2,  # 40 - 47
    2, 2, 2, 2, 2, 2, 2, 2,  # 48 - 4f
    2, 2, 2, 2, 2, 2, 2, 2,  # 50 - 57
    2, 2, 2, 2, 2, 2, 2, 2,  # 58 - 5f
    2, 2, 2, 2, 2, 2, 2, 2,  # 60 - 67
    2, 2, 2, 2, 2, 2, 2, 2,  # 68 - 6f
    2, 2, 2, 2, 2, 2, 2, 2,  # 70 - 77
    2, 2, 2, 2, 2, 2, 2, 2,  # 78 - 7f
    0, 0, 0, 0, 0, 0, 0, 0,  # 80 - 87
    0, 0, 0, 0, 0, 0, 6, 0,  # 88 - 8f
    0, 0, 0, 0, 0, 0, 0, 0,  # 90 - 97
    0, 0, 0, 0, 0, 0, 0, 0,  # 98 - 9f
    0, 3, 4, 4, 4, 4, 4, 4,  # a0 - a7
    5, 5, 1, 1, 1, 1, 1, 1,  # a8 - af
    1, 1, 1, 1, 1, 1, 1, 1,  # b0 - b7
    1, 1, 1, 1, 1, 1, 1, 1,  # b8 - bf
    1, 1, 3, 1, 3, 3, 3, 3,  # c0 - c7
    3, 3, 3, 3, 3, 3, 3, 3,  # c8 - cf
    3, 3, 3, 3, 3, 3, 3, 3,  # d0 - d7
    3, 3, 3, 3, 3, 3, 3, 3,  # d8 - df
    3, 3, 3, 3, 3, 3, 3, 3,  # e0 - e7
    3, 3, 3, 3, 3, 3, 3, 3,  # e8 - ef
    3, 3, 3, 3, 3, 3, 3, 3,  # f0 - f7
    3, 3, 3, 3, 3, 3, 3, 0   # f8 - ff
)

EUCTW_ST = (
    MachineState.ERROR,MachineState.ERROR,MachineState.START,     3,     3,     3,     4,MachineState.ERROR,#00-07
    MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ITS_ME,MachineState.ITS_ME,#08-0f
    MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ERROR,MachineState.START,MachineState.ERROR,#10-17
    MachineState.START,MachineState.START,MachineState.START,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,#18-1f
         5,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.START,MachineState.ERROR,MachineState.START,MachineState.START,#20-27
    MachineState.START,MachineState.ERROR,MachineState.START,MachineState.START,MachineState.START,MachineState.START,MachineState.START,MachineState.START #28-2f
)
# fmt: on

EUCTW_CHAR_LEN_TABLE = (0, 0, 1, 2, 2, 2, 3)

EUCTW_SM_MODEL: CodingStateMachineDict = {
    "class_table": EUCTW_CLS,
    "class_factor": 7,
    "state_table": EUCTW_ST,
    "char_len_table": EUCTW_CHAR_LEN_TABLE,
    "name": "x-euc-tw",
}

# GB2312
# fmt: off
GB2312_CLS = (
    1, 1, 1, 1, 1, 1, 1, 1,  # 00 - 07
    1, 1, 1, 1, 1, 1, 0, 0,  # 08 - 0f
    1, 1, 1, 1, 1, 1, 1, 1,  # 10 - 17
    1, 1, 1, 0, 1, 1, 1, 1,  # 18 - 1f
    1, 1, 1, 1, 1, 1, 1, 1,  # 20 - 27
    1, 1, 1, 1, 1, 1, 1, 1,  # 28 - 2f
    3, 3, 3, 3, 3, 3, 3, 3,  # 30 - 37
    3, 3, 1, 1, 1, 1, 1, 1,  # 38 - 3f
    2, 2, 2, 2, 2, 2, 2, 2,  # 40 - 47
    2, 2, 2, 2, 2, 2, 2, 2,  # 48 - 4f
    2, 2, 2, 2, 2, 2, 2, 2,  # 50 - 57
    2, 2, 2, 2, 2, 2, 2, 2,  # 58 - 5f
    2, 2, 2, 2, 2, 2, 2, 2,  # 60 - 67
    2, 2, 2, 2, 2, 2, 2, 2,  # 68 - 6f
    2, 2, 2, 2, 2, 2, 2, 2,  # 70 - 77
    2, 2, 2, 2, 2, 2, 2, 4,  # 78 - 7f
    5, 6, 6, 6, 6, 6, 6, 6,  # 80 - 87
    6, 6, 6, 6, 6, 6, 6, 6,  # 88 - 8f
    6, 6, 6, 6, 6, 6, 6, 6,  # 90 - 97
    6, 6, 6, 6, 6, 6, 6, 6,  # 98 - 9f
    6, 6, 6, 6, 6, 6, 6, 6,  # a0 - a7
    6, 6, 6, 6, 6, 6, 6, 6,  # a8 - af
    6, 6, 6, 6, 6, 6, 6, 6,  # b0 - b7
    6, 6, 6, 6, 6, 6, 6, 6,  # b8 - bf
    6, 6, 6, 6, 6, 6, 6, 6,  # c0 - c7
    6, 6, 6, 6, 6, 6, 6, 6,  # c8 - cf
    6, 6, 6, 6, 6, 6, 6, 6,  # d0 - d7
    6, 6, 6, 6, 6, 6, 6, 6,  # d8 - df
    6, 6, 6, 6, 6, 6, 6, 6,  # e0 - e7
    6, 6, 6, 6, 6, 6, 6, 6,  # e8 - ef
    6, 6, 6, 6, 6, 6, 6, 6,  # f0 - f7
    6, 6, 6, 6, 6, 6, 6, 0   # f8 - ff
)

GB2312_ST = (
    MachineState.ERROR,MachineState.START,MachineState.START,MachineState.START,MachineState.START,MachineState.START,     3,MachineState.ERROR,#00-07
    MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ITS_ME,MachineState.ITS_ME,#08-0f
    MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ERROR,MachineState.ERROR,MachineState.START,#10-17
         4,MachineState.ERROR,MachineState.START,MachineState.START,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,#18-1f
    MachineState.ERROR,MachineState.ERROR,     5,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ITS_ME,MachineState.ERROR,#20-27
    MachineState.ERROR,MachineState.ERROR,MachineState.START,MachineState.START,MachineState.START,MachineState.START,MachineState.START,MachineState.START #28-2f
)
# fmt: on

# To be accurate, the length of class 6 can be either 2 or 4.
# But it is not necessary to discriminate between the two since
# it is used for frequency analysis only, and we are validating
# each code range there as well. So it is safe to set it to be
# 2 here.
GB2312_CHAR_LEN_TABLE = (0, 1, 1, 1, 1, 1, 2)

GB2312_SM_MODEL: CodingStateMachineDict = {
    "class_table": GB2312_CLS,
    "class_factor": 7,
    "state_table": GB2312_ST,
    "char_len_table": GB2312_CHAR_LEN_TABLE,
    "name": "GB2312",
}

# Shift_JIS
# fmt: off
SJIS_CLS = (
    1, 1, 1, 1, 1, 1, 1, 1,  # 00 - 07
    1, 1, 1, 1, 1, 1, 0, 0,  # 08 - 0f
    1, 1, 1, 1, 1, 1, 1, 1,  # 10 - 17
    1, 1, 1, 0, 1, 1, 1, 1,  # 18 - 1f
    1, 1, 1, 1, 1, 1, 1, 1,  # 20 - 27
    1, 1, 1, 1, 1, 1, 1, 1,  # 28 - 2f
    1, 1, 1, 1, 1, 1, 1, 1,  # 30 - 37
    1, 1, 1, 1, 1, 1, 1, 1,  # 38 - 3f
    2, 2, 2, 2, 2, 2, 2, 2,  # 40 - 47
    2, 2, 2, 2, 2, 2, 2, 2,  # 48 - 4f
    2, 2, 2, 2, 2, 2, 2, 2,  # 50 - 57
    2, 2, 2, 2, 2, 2, 2, 2,  # 58 - 5f
    2, 2, 2, 2, 2, 2, 2, 2,  # 60 - 67
    2, 2, 2, 2, 2, 2, 2, 2,  # 68 - 6f
    2, 2, 2, 2, 2, 2, 2, 2,  # 70 - 77
    2, 2, 2, 2, 2, 2, 2, 1,  # 78 - 7f
    3, 3, 3, 3, 3, 2, 2, 3,  # 80 - 87
    3, 3, 3, 3, 3, 3, 3, 3,  # 88 - 8f
    3, 3, 3, 3, 3, 3, 3, 3,  # 90 - 97
    3, 3, 3, 3, 3, 3, 3, 3,  # 98 - 9f
    #0xa0 is illegal in sjis encoding, but some pages does
    #contain such byte. We need to be more error forgiven.
    2, 2, 2, 2, 2, 2, 2, 2,  # a0 - a7
    2, 2, 2, 2, 2, 2, 2, 2,  # a8 - af
    2, 2, 2, 2, 2, 2, 2, 2,  # b0 - b7
    2, 2, 2, 2, 2, 2, 2, 2,  # b8 - bf
    2, 2, 2, 2, 2, 2, 2, 2,  # c0 - c7
    2, 2, 2, 2, 2, 2, 2, 2,  # c8 - cf
    2, 2, 2, 2, 2, 2, 2, 2,  # d0 - d7
    2, 2, 2, 2, 2, 2, 2, 2,  # d8 - df
    3, 3, 3, 3, 3, 3, 3, 3,  # e0 - e7
    3, 3, 3, 3, 3, 4, 4, 4,  # e8 - ef
    3, 3, 3, 3, 3, 3, 3, 3,  # f0 - f7
    3, 3, 3, 3, 3, 0, 0, 0,  # f8 - ff
)

SJIS_ST = (
    MachineState.ERROR,MachineState.START,MachineState.START,     3,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,#00-07
    MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,#08-0f
    MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ERROR,MachineState.ERROR,MachineState.START,MachineState.START,MachineState.START,MachineState.START #10-17
)
# fmt: on

SJIS_CHAR_LEN_TABLE = (0, 1, 1, 2, 0, 0)

SJIS_SM_MODEL: CodingStateMachineDict = {
    "class_table": SJIS_CLS,
    "class_factor": 6,
    "state_table": SJIS_ST,
    "char_len_table": SJIS_CHAR_LEN_TABLE,
    "name": "Shift_JIS",
}

# UCS2-BE
# fmt: off
UCS2BE_CLS = (
    0, 0, 0, 0, 0, 0, 0, 0,  # 00 - 07
    0, 0, 1, 0, 0, 2, 0, 0,  # 08 - 0f
    0, 0, 0, 0, 0, 0, 0, 0,  # 10 - 17
    0, 0, 0, 3, 0, 0, 0, 0,  # 18 - 1f
    0, 0, 0, 0, 0, 0, 0, 0,  # 20 - 27
    0, 3, 3, 3, 3, 3, 0, 0,  # 28 - 2f
    0, 0, 0, 0, 0, 0, 0, 0,  # 30 - 37
    0, 0, 0, 0, 0, 0, 0, 0,  # 38 - 3f
    0, 0, 0, 0, 0, 0, 0, 0,  # 40 - 47
    0, 0, 0, 0, 0, 0, 0, 0,  # 48 - 4f
    0, 0, 0, 0, 0, 0, 0, 0,  # 50 - 57
    0, 0, 0, 0, 0, 0, 0, 0,  # 58 - 5f
    0, 0, 0, 0, 0, 0, 0, 0,  # 60 - 67
    0, 0, 0, 0, 0, 0, 0, 0,  # 68 - 6f
    0, 0, 0, 0, 0, 0, 0, 0,  # 70 - 77
    0, 0, 0, 0, 0, 0, 0, 0,  # 78 - 7f
    0, 0, 0, 0, 0, 0, 0, 0,  # 80 - 87
    0, 0, 0, 0, 0, 0, 0, 0,  # 88 - 8f
    0, 0, 0, 0, 0, 0, 0, 0,  # 90 - 97
    0, 0, 0, 0, 0, 0, 0, 0,  # 98 - 9f
    0, 0, 0, 0, 0, 0, 0, 0,  # a0 - a7
    0, 0, 0, 0, 0, 0, 0, 0,  # a8 - af
    0, 0, 0, 0, 0, 0, 0, 0,  # b0 - b7
    0, 0, 0, 0, 0, 0, 0, 0,  # b8 - bf
    0, 0, 0, 0, 0, 0, 0, 0,  # c0 - c7
    0, 0, 0, 0, 0, 0, 0, 0,  # c8 - cf
    0, 0, 0, 0, 0, 0, 0, 0,  # d0 - d7
    0, 0, 0, 0, 0, 0, 0, 0,  # d8 - df
    0, 0, 0, 0, 0, 0, 0, 0,  # e0 - e7
    0, 0, 0, 0, 0, 0, 0, 0,  # e8 - ef
    0, 0, 0, 0, 0, 0, 0, 0,  # f0 - f7
    0, 0, 0, 0, 0, 0, 4, 5   # f8 - ff
)

UCS2BE_ST  = (
          5,     7,     7,MachineState.ERROR,     4,     3,MachineState.ERROR,MachineState.ERROR,#00-07
     MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,#08-0f
     MachineState.ITS_ME,MachineState.ITS_ME,     6,     6,     6,     6,MachineState.ERROR,MachineState.ERROR,#10-17
          6,     6,     6,     6,     6,MachineState.ITS_ME,     6,     6,#18-1f
          6,     6,     6,     6,     5,     7,     7,MachineState.ERROR,#20-27
          5,     8,     6,     6,MachineState.ERROR,     6,     6,     6,#28-2f
          6,     6,     6,     6,MachineState.ERROR,MachineState.ERROR,MachineState.START,MachineState.START #30-37
)
# fmt: on

UCS2BE_CHAR_LEN_TABLE = (2, 2, 2, 0, 2, 2)

UCS2BE_SM_MODEL: CodingStateMachineDict = {
    "class_table": UCS2BE_CLS,
    "class_factor": 6,
    "state_table": UCS2BE_ST,
    "char_len_table": UCS2BE_CHAR_LEN_TABLE,
    "name": "UTF-16BE",
}

# UCS2-LE
# fmt: off
UCS2LE_CLS = (
    0, 0, 0, 0, 0, 0, 0, 0,  # 00 - 07
    0, 0, 1, 0, 0, 2, 0, 0,  # 08 - 0f
    0, 0, 0, 0, 0, 0, 0, 0,  # 10 - 17
    0, 0, 0, 3, 0, 0, 0, 0,  # 18 - 1f
    0, 0, 0, 0, 0, 0, 0, 0,  # 20 - 27
    0, 3, 3, 3, 3, 3, 0, 0,  # 28 - 2f
    0, 0, 0, 0, 0, 0, 0, 0,  # 30 - 37
    0, 0, 0, 0, 0, 0, 0, 0,  # 38 - 3f
    0, 0, 0, 0, 0, 0, 0, 0,  # 40 - 47
    0, 0, 0, 0, 0, 0, 0, 0,  # 48 - 4f
    0, 0, 0, 0, 0, 0, 0, 0,  # 50 - 57
    0, 0, 0, 0, 0, 0, 0, 0,  # 58 - 5f
    0, 0, 0, 0, 0, 0, 0, 0,  # 60 - 67
    0, 0, 0, 0, 0, 0, 0, 0,  # 68 - 6f
    0, 0, 0, 0, 0, 0, 0, 0,  # 70 - 77
    0, 0, 0, 0, 0, 0, 0, 0,  # 78 - 7f
    0, 0, 0, 0, 0, 0, 0, 0,  # 80 - 87
    0, 0, 0, 0, 0, 0, 0, 0,  # 88 - 8f
    0, 0, 0, 0, 0, 0, 0, 0,  # 90 - 97
    0, 0, 0, 0, 0, 0, 0, 0,  # 98 - 9f
    0, 0, 0, 0, 0, 0, 0, 0,  # a0 - a7
    0, 0, 0, 0, 0, 0, 0, 0,  # a8 - af
    0, 0, 0, 0, 0, 0, 0, 0,  # b0 - b7
    0, 0, 0, 0, 0, 0, 0, 0,  # b8 - bf
    0, 0, 0, 0, 0, 0, 0, 0,  # c0 - c7
    0, 0, 0, 0, 0, 0, 0, 0,  # c8 - cf
    0, 0, 0, 0, 0, 0, 0, 0,  # d0 - d7
    0, 0, 0, 0, 0, 0, 0, 0,  # d8 - df
    0, 0, 0, 0, 0, 0, 0, 0,  # e0 - e7
    0, 0, 0, 0, 0, 0, 0, 0,  # e8 - ef
    0, 0, 0, 0, 0, 0, 0, 0,  # f0 - f7
    0, 0, 0, 0, 0, 0, 4, 5   # f8 - ff
)

UCS2LE_ST = (
          6,     6,     7,     6,     4,     3,MachineState.ERROR,MachineState.ERROR,#00-07
     MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,#08-0f
     MachineState.ITS_ME,MachineState.ITS_ME,     5,     5,     5,MachineState.ERROR,MachineState.ITS_ME,MachineState.ERROR,#10-17
          5,     5,     5,MachineState.ERROR,     5,MachineState.ERROR,     6,     6,#18-1f
          7,     6,     8,     8,     5,     5,     5,MachineState.ERROR,#20-27
          5,     5,     5,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,     5,     5,#28-2f
          5,     5,     5,MachineState.ERROR,     5,MachineState.ERROR,MachineState.START,MachineState.START #30-37
)
# fmt: on

UCS2LE_CHAR_LEN_TABLE = (2, 2, 2, 2, 2, 2)

UCS2LE_SM_MODEL: CodingStateMachineDict = {
    "class_table": UCS2LE_CLS,
    "class_factor": 6,
    "state_table": UCS2LE_ST,
    "char_len_table": UCS2LE_CHAR_LEN_TABLE,
    "name": "UTF-16LE",
}

# UTF-8
# fmt: off
UTF8_CLS = (
    1, 1, 1, 1, 1, 1, 1, 1,  # 00 - 07  #allow 0x00 as a legal value
    1, 1, 1, 1, 1, 1, 0, 0,  # 08 - 0f
    1, 1, 1, 1, 1, 1, 1, 1,  # 10 - 17
    1, 1, 1, 0, 1, 1, 1, 1,  # 18 - 1f
    1, 1, 1, 1, 1, 1, 1, 1,  # 20 - 27
    1, 1, 1, 1, 1, 1, 1, 1,  # 28 - 2f
    1, 1, 1, 1, 1, 1, 1, 1,  # 30 - 37
    1, 1, 1, 1, 1, 1, 1, 1,  # 38 - 3f
    1, 1, 1, 1, 1, 1, 1, 1,  # 40 - 47
    1, 1, 1, 1, 1, 1, 1, 1,  # 48 - 4f
    1, 1, 1, 1, 1, 1, 1, 1,  # 50 - 57
    1, 1, 1, 1, 1, 1, 1, 1,  # 58 - 5f
    1, 1, 1, 1, 1, 1, 1, 1,  # 60 - 67
    1, 1, 1, 1, 1, 1, 1, 1,  # 68 - 6f
    1, 1, 1, 1, 1, 1, 1, 1,  # 70 - 77
    1, 1, 1, 1, 1, 1, 1, 1,  # 78 - 7f
    2, 2, 2, 2, 3, 3, 3, 3,  # 80 - 87
    4, 4, 4, 4, 4, 4, 4, 4,  # 88 - 8f
    4, 4, 4, 4, 4, 4, 4, 4,  # 90 - 97
    4, 4, 4, 4, 4, 4, 4, 4,  # 98 - 9f
    5, 5, 5, 5, 5, 5, 5, 5,  # a0 - a7
    5, 5, 5, 5, 5, 5, 5, 5,  # a8 - af
    5, 5, 5, 5, 5, 5, 5, 5,  # b0 - b7
    5, 5, 5, 5, 5, 5, 5, 5,  # b8 - bf
    0, 0, 6, 6, 6, 6, 6, 6,  # c0 - c7
    6, 6, 6, 6, 6, 6, 6, 6,  # c8 - cf
    6, 6, 6, 6, 6, 6, 6, 6,  # d0 - d7
    6, 6, 6, 6, 6, 6, 6, 6,  # d8 - df
    7, 8, 8, 8, 8, 8, 8, 8,  # e0 - e7
    8, 8, 8, 8, 8, 9, 8, 8,  # e8 - ef
    10, 11, 11, 11, 11, 11, 11, 11,  # f0 - f7
    12, 13, 13, 13, 14, 15, 0, 0    # f8 - ff
)

UTF8_ST = (
    MachineState.ERROR,MachineState.START,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,     12,   10,#00-07
         9,     11,     8,     7,     6,     5,     4,    3,#08-0f
    MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,#10-17
    MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,#18-1f
    MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,#20-27
    MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,MachineState.ITS_ME,#28-2f
    MachineState.ERROR,MachineState.ERROR,     5,     5,     5,     5,MachineState.ERROR,MachineState.ERROR,#30-37
    MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,#38-3f
    MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,     5,     5,     5,MachineState.ERROR,MachineState.ERROR,#40-47
    MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,#48-4f
    MachineState.ERROR,MachineState.ERROR,     7,     7,     7,     7,MachineState.ERROR,MachineState.ERROR,#50-57
    MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,#58-5f
    MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,     7,     7,MachineState.ERROR,MachineState.ERROR,#60-67
    MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,#68-6f
    MachineState.ERROR,MachineState.ERROR,     9,     9,     9,     9,MachineState.ERROR,MachineState.ERROR,#70-77
    MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,#78-7f
    MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,     9,MachineState.ERROR,MachineState.ERROR,#80-87
    MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,#88-8f
    MachineState.ERROR,MachineState.ERROR,    12,    12,    12,    12,MachineState.ERROR,MachineState.ERROR,#90-97
    MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,#98-9f
    MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,    12,MachineState.ERROR,MachineState.ERROR,#a0-a7
    MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,#a8-af
    MachineState.ERROR,MachineState.ERROR,    12,    12,    12,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,#b0-b7
    MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,#b8-bf
    MachineState.ERROR,MachineState.ERROR,MachineState.START,MachineState.START,MachineState.START,MachineState.START,MachineState.ERROR,MachineState.ERROR,#c0-c7
    MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR,MachineState.ERROR #c8-cf
)
# fmt: on

UTF8_CHAR_LEN_TABLE = (0, 1, 0, 0, 0, 0, 2, 3, 3, 3, 4, 4, 5, 5, 6, 6)

UTF8_SM_MODEL: CodingStateMachineDict = {
    "class_table": UTF8_CLS,
    "class_factor": 16,
    "state_table": UTF8_ST,
    "char_len_table": UTF8_CHAR_LEN_TABLE,
    "name": "UTF-8",
}
