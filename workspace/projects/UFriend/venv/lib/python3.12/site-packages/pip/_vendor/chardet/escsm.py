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
# version 2.1 of the License,  or (at your option) any later version.
#
# This library is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
# Lesser General Public License for more details.
#
# You should have received a copy of the GNU Lesser General Public
# License along with this library; if not,  write to the Free Software
# Foundation,  Inc.,  51 Franklin St,  Fifth Floor,  Boston,  MA
# 02110-1301  USA
######################### END LICENSE BLOCK #########################

from .codingstatemachinedict import CodingStateMachineDict
from .enums import MachineState

# fmt: off
HZ_CLS = (
    1, 0, 0, 0, 0, 0, 0, 0,  # 00 - 07
    0, 0, 0, 0, 0, 0, 0, 0,  # 08 - 0f
    0, 0, 0, 0, 0, 0, 0, 0,  # 10 - 17
    0, 0, 0, 1, 0, 0, 0, 0,  # 18 - 1f
    0, 0, 0, 0, 0, 0, 0, 0,  # 20 - 27
    0, 0, 0, 0, 0, 0, 0, 0,  # 28 - 2f
    0, 0, 0, 0, 0, 0, 0, 0,  # 30 - 37
    0, 0, 0, 0, 0, 0, 0, 0,  # 38 - 3f
    0, 0, 0, 0, 0, 0, 0, 0,  # 40 - 47
    0, 0, 0, 0, 0, 0, 0, 0,  # 48 - 4f
    0, 0, 0, 0, 0, 0, 0, 0,  # 50 - 57
    0, 0, 0, 0, 0, 0, 0, 0,  # 58 - 5f
    0, 0, 0, 0, 0, 0, 0, 0,  # 60 - 67
    0, 0, 0, 0, 0, 0, 0, 0,  # 68 - 6f
    0, 0, 0, 0, 0, 0, 0, 0,  # 70 - 77
    0, 0, 0, 4, 0, 5, 2, 0,  # 78 - 7f
    1, 1, 1, 1, 1, 1, 1, 1,  # 80 - 87
    1, 1, 1, 1, 1, 1, 1, 1,  # 88 - 8f
    1, 1, 1, 1, 1, 1, 1, 1,  # 90 - 97
    1, 1, 1, 1, 1, 1, 1, 1,  # 98 - 9f
    1, 1, 1, 1, 1, 1, 1, 1,  # a0 - a7
    1, 1, 1, 1, 1, 1, 1, 1,  # a8 - af
    1, 1, 1, 1, 1, 1, 1, 1,  # b0 - b7
    1, 1, 1, 1, 1, 1, 1, 1,  # b8 - bf
    1, 1, 1, 1, 1, 1, 1, 1,  # c0 - c7
    1, 1, 1, 1, 1, 1, 1, 1,  # c8 - cf
    1, 1, 1, 1, 1, 1, 1, 1,  # d0 - d7
    1, 1, 1, 1, 1, 1, 1, 1,  # d8 - df
    1, 1, 1, 1, 1, 1, 1, 1,  # e0 - e7
    1, 1, 1, 1, 1, 1, 1, 1,  # e8 - ef
    1, 1, 1, 1, 1, 1, 1, 1,  # f0 - f7
    1, 1, 1, 1, 1, 1, 1, 1,  # f8 - ff
)

HZ_ST = (
MachineState.START, MachineState.ERROR,      3, MachineState.START, MachineState.START, MachineState.START, MachineState.ERROR, MachineState.ERROR, # 00-07
MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ITS_ME, MachineState.ITS_ME, MachineState.ITS_ME, MachineState.ITS_ME, # 08-0f
MachineState.ITS_ME, MachineState.ITS_ME, MachineState.ERROR, MachineState.ERROR, MachineState.START, MachineState.START,      4, MachineState.ERROR, # 10-17
     5, MachineState.ERROR,      6, MachineState.ERROR,      5,      5,      4, MachineState.ERROR, # 18-1f
     4, MachineState.ERROR,      4,      4,      4, MachineState.ERROR,      4, MachineState.ERROR, # 20-27
     4, MachineState.ITS_ME, MachineState.START, MachineState.START, MachineState.START, MachineState.START, MachineState.START, MachineState.START, # 28-2f
)
# fmt: on

HZ_CHAR_LEN_TABLE = (0, 0, 0, 0, 0, 0)

HZ_SM_MODEL: CodingStateMachineDict = {
    "class_table": HZ_CLS,
    "class_factor": 6,
    "state_table": HZ_ST,
    "char_len_table": HZ_CHAR_LEN_TABLE,
    "name": "HZ-GB-2312",
    "language": "Chinese",
}

# fmt: off
ISO2022CN_CLS = (
    2, 0, 0, 0, 0, 0, 0, 0,  # 00 - 07
    0, 0, 0, 0, 0, 0, 0, 0,  # 08 - 0f
    0, 0, 0, 0, 0, 0, 0, 0,  # 10 - 17
    0, 0, 0, 1, 0, 0, 0, 0,  # 18 - 1f
    0, 0, 0, 0, 0, 0, 0, 0,  # 20 - 27
    0, 3, 0, 0, 0, 0, 0, 0,  # 28 - 2f
    0, 0, 0, 0, 0, 0, 0, 0,  # 30 - 37
    0, 0, 0, 0, 0, 0, 0, 0,  # 38 - 3f
    0, 0, 0, 4, 0, 0, 0, 0,  # 40 - 47
    0, 0, 0, 0, 0, 0, 0, 0,  # 48 - 4f
    0, 0, 0, 0, 0, 0, 0, 0,  # 50 - 57
    0, 0, 0, 0, 0, 0, 0, 0,  # 58 - 5f
    0, 0, 0, 0, 0, 0, 0, 0,  # 60 - 67
    0, 0, 0, 0, 0, 0, 0, 0,  # 68 - 6f
    0, 0, 0, 0, 0, 0, 0, 0,  # 70 - 77
    0, 0, 0, 0, 0, 0, 0, 0,  # 78 - 7f
    2, 2, 2, 2, 2, 2, 2, 2,  # 80 - 87
    2, 2, 2, 2, 2, 2, 2, 2,  # 88 - 8f
    2, 2, 2, 2, 2, 2, 2, 2,  # 90 - 97
    2, 2, 2, 2, 2, 2, 2, 2,  # 98 - 9f
    2, 2, 2, 2, 2, 2, 2, 2,  # a0 - a7
    2, 2, 2, 2, 2, 2, 2, 2,  # a8 - af
    2, 2, 2, 2, 2, 2, 2, 2,  # b0 - b7
    2, 2, 2, 2, 2, 2, 2, 2,  # b8 - bf
    2, 2, 2, 2, 2, 2, 2, 2,  # c0 - c7
    2, 2, 2, 2, 2, 2, 2, 2,  # c8 - cf
    2, 2, 2, 2, 2, 2, 2, 2,  # d0 - d7
    2, 2, 2, 2, 2, 2, 2, 2,  # d8 - df
    2, 2, 2, 2, 2, 2, 2, 2,  # e0 - e7
    2, 2, 2, 2, 2, 2, 2, 2,  # e8 - ef
    2, 2, 2, 2, 2, 2, 2, 2,  # f0 - f7
    2, 2, 2, 2, 2, 2, 2, 2,  # f8 - ff
)

ISO2022CN_ST = (
    MachineState.START,      3, MachineState.ERROR, MachineState.START, MachineState.START, MachineState.START, MachineState.START, MachineState.START, # 00-07
    MachineState.START, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, # 08-0f
    MachineState.ERROR, MachineState.ERROR, MachineState.ITS_ME, MachineState.ITS_ME, MachineState.ITS_ME, MachineState.ITS_ME, MachineState.ITS_ME, MachineState.ITS_ME, # 10-17
    MachineState.ITS_ME, MachineState.ITS_ME, MachineState.ITS_ME, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR,      4, MachineState.ERROR, # 18-1f
    MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ITS_ME, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, # 20-27
        5,      6, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, # 28-2f
    MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ITS_ME, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, # 30-37
    MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ITS_ME, MachineState.ERROR, MachineState.START, # 38-3f
)
# fmt: on

ISO2022CN_CHAR_LEN_TABLE = (0, 0, 0, 0, 0, 0, 0, 0, 0)

ISO2022CN_SM_MODEL: CodingStateMachineDict = {
    "class_table": ISO2022CN_CLS,
    "class_factor": 9,
    "state_table": ISO2022CN_ST,
    "char_len_table": ISO2022CN_CHAR_LEN_TABLE,
    "name": "ISO-2022-CN",
    "language": "Chinese",
}

# fmt: off
ISO2022JP_CLS = (
    2, 0, 0, 0, 0, 0, 0, 0,  # 00 - 07
    0, 0, 0, 0, 0, 0, 2, 2,  # 08 - 0f
    0, 0, 0, 0, 0, 0, 0, 0,  # 10 - 17
    0, 0, 0, 1, 0, 0, 0, 0,  # 18 - 1f
    0, 0, 0, 0, 7, 0, 0, 0,  # 20 - 27
    3, 0, 0, 0, 0, 0, 0, 0,  # 28 - 2f
    0, 0, 0, 0, 0, 0, 0, 0,  # 30 - 37
    0, 0, 0, 0, 0, 0, 0, 0,  # 38 - 3f
    6, 0, 4, 0, 8, 0, 0, 0,  # 40 - 47
    0, 9, 5, 0, 0, 0, 0, 0,  # 48 - 4f
    0, 0, 0, 0, 0, 0, 0, 0,  # 50 - 57
    0, 0, 0, 0, 0, 0, 0, 0,  # 58 - 5f
    0, 0, 0, 0, 0, 0, 0, 0,  # 60 - 67
    0, 0, 0, 0, 0, 0, 0, 0,  # 68 - 6f
    0, 0, 0, 0, 0, 0, 0, 0,  # 70 - 77
    0, 0, 0, 0, 0, 0, 0, 0,  # 78 - 7f
    2, 2, 2, 2, 2, 2, 2, 2,  # 80 - 87
    2, 2, 2, 2, 2, 2, 2, 2,  # 88 - 8f
    2, 2, 2, 2, 2, 2, 2, 2,  # 90 - 97
    2, 2, 2, 2, 2, 2, 2, 2,  # 98 - 9f
    2, 2, 2, 2, 2, 2, 2, 2,  # a0 - a7
    2, 2, 2, 2, 2, 2, 2, 2,  # a8 - af
    2, 2, 2, 2, 2, 2, 2, 2,  # b0 - b7
    2, 2, 2, 2, 2, 2, 2, 2,  # b8 - bf
    2, 2, 2, 2, 2, 2, 2, 2,  # c0 - c7
    2, 2, 2, 2, 2, 2, 2, 2,  # c8 - cf
    2, 2, 2, 2, 2, 2, 2, 2,  # d0 - d7
    2, 2, 2, 2, 2, 2, 2, 2,  # d8 - df
    2, 2, 2, 2, 2, 2, 2, 2,  # e0 - e7
    2, 2, 2, 2, 2, 2, 2, 2,  # e8 - ef
    2, 2, 2, 2, 2, 2, 2, 2,  # f0 - f7
    2, 2, 2, 2, 2, 2, 2, 2,  # f8 - ff
)

ISO2022JP_ST = (
    MachineState.START,      3, MachineState.ERROR, MachineState.START, MachineState.START, MachineState.START, MachineState.START, MachineState.START, # 00-07
    MachineState.START, MachineState.START, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, # 08-0f
    MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ITS_ME, MachineState.ITS_ME, MachineState.ITS_ME, MachineState.ITS_ME, # 10-17
    MachineState.ITS_ME, MachineState.ITS_ME, MachineState.ITS_ME, MachineState.ITS_ME, MachineState.ITS_ME, MachineState.ITS_ME, MachineState.ERROR, MachineState.ERROR, # 18-1f
    MachineState.ERROR,      5, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR,      4, MachineState.ERROR, MachineState.ERROR, # 20-27
    MachineState.ERROR, MachineState.ERROR, MachineState.ERROR,      6, MachineState.ITS_ME, MachineState.ERROR, MachineState.ITS_ME, MachineState.ERROR, # 28-2f
    MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ITS_ME, MachineState.ITS_ME, # 30-37
    MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ITS_ME, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, # 38-3f
    MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ITS_ME, MachineState.ERROR, MachineState.START, MachineState.START, # 40-47
)
# fmt: on

ISO2022JP_CHAR_LEN_TABLE = (0, 0, 0, 0, 0, 0, 0, 0, 0, 0)

ISO2022JP_SM_MODEL: CodingStateMachineDict = {
    "class_table": ISO2022JP_CLS,
    "class_factor": 10,
    "state_table": ISO2022JP_ST,
    "char_len_table": ISO2022JP_CHAR_LEN_TABLE,
    "name": "ISO-2022-JP",
    "language": "Japanese",
}

# fmt: off
ISO2022KR_CLS = (
    2, 0, 0, 0, 0, 0, 0, 0,  # 00 - 07
    0, 0, 0, 0, 0, 0, 0, 0,  # 08 - 0f
    0, 0, 0, 0, 0, 0, 0, 0,  # 10 - 17
    0, 0, 0, 1, 0, 0, 0, 0,  # 18 - 1f
    0, 0, 0, 0, 3, 0, 0, 0,  # 20 - 27
    0, 4, 0, 0, 0, 0, 0, 0,  # 28 - 2f
    0, 0, 0, 0, 0, 0, 0, 0,  # 30 - 37
    0, 0, 0, 0, 0, 0, 0, 0,  # 38 - 3f
    0, 0, 0, 5, 0, 0, 0, 0,  # 40 - 47
    0, 0, 0, 0, 0, 0, 0, 0,  # 48 - 4f
    0, 0, 0, 0, 0, 0, 0, 0,  # 50 - 57
    0, 0, 0, 0, 0, 0, 0, 0,  # 58 - 5f
    0, 0, 0, 0, 0, 0, 0, 0,  # 60 - 67
    0, 0, 0, 0, 0, 0, 0, 0,  # 68 - 6f
    0, 0, 0, 0, 0, 0, 0, 0,  # 70 - 77
    0, 0, 0, 0, 0, 0, 0, 0,  # 78 - 7f
    2, 2, 2, 2, 2, 2, 2, 2,  # 80 - 87
    2, 2, 2, 2, 2, 2, 2, 2,  # 88 - 8f
    2, 2, 2, 2, 2, 2, 2, 2,  # 90 - 97
    2, 2, 2, 2, 2, 2, 2, 2,  # 98 - 9f
    2, 2, 2, 2, 2, 2, 2, 2,  # a0 - a7
    2, 2, 2, 2, 2, 2, 2, 2,  # a8 - af
    2, 2, 2, 2, 2, 2, 2, 2,  # b0 - b7
    2, 2, 2, 2, 2, 2, 2, 2,  # b8 - bf
    2, 2, 2, 2, 2, 2, 2, 2,  # c0 - c7
    2, 2, 2, 2, 2, 2, 2, 2,  # c8 - cf
    2, 2, 2, 2, 2, 2, 2, 2,  # d0 - d7
    2, 2, 2, 2, 2, 2, 2, 2,  # d8 - df
    2, 2, 2, 2, 2, 2, 2, 2,  # e0 - e7
    2, 2, 2, 2, 2, 2, 2, 2,  # e8 - ef
    2, 2, 2, 2, 2, 2, 2, 2,  # f0 - f7
    2, 2, 2, 2, 2, 2, 2, 2,  # f8 - ff
)

ISO2022KR_ST = (
    MachineState.START,      3, MachineState.ERROR, MachineState.START, MachineState.START, MachineState.START, MachineState.ERROR, MachineState.ERROR, # 00-07
    MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ITS_ME, MachineState.ITS_ME, MachineState.ITS_ME, MachineState.ITS_ME, # 08-0f
    MachineState.ITS_ME, MachineState.ITS_ME, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR,      4, MachineState.ERROR, MachineState.ERROR, # 10-17
    MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR,      5, MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, # 18-1f
    MachineState.ERROR, MachineState.ERROR, MachineState.ERROR, MachineState.ITS_ME, MachineState.START, MachineState.START, MachineState.START, MachineState.START, # 20-27
)
# fmt: on

ISO2022KR_CHAR_LEN_TABLE = (0, 0, 0, 0, 0, 0)

ISO2022KR_SM_MODEL: CodingStateMachineDict = {
    "class_table": ISO2022KR_CLS,
    "class_factor": 6,
    "state_table": ISO2022KR_ST,
    "char_len_table": ISO2022KR_CHAR_LEN_TABLE,
    "name": "ISO-2022-KR",
    "language": "Korean",
}
