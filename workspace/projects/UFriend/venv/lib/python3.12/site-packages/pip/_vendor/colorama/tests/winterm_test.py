# Copyright Jonathan Hartley 2013. BSD 3-Clause license, see LICENSE file.
import sys
from unittest import TestCase, main, skipUnless

try:
    from unittest.mock import Mock, patch
except ImportError:
    from mock import Mock, patch

from ..winterm import WinColor, WinStyle, WinTerm


class WinTermTest(TestCase):

    @patch('colorama.winterm.win32')
    def testInit(self, mockWin32):
        mockAttr = Mock()
        mockAttr.wAttributes = 7 + 6 * 16 + 8
        mockWin32.GetConsoleScreenBufferInfo.return_value = mockAttr
        term = WinTerm()
        self.assertEqual(term._fore, 7)
        self.assertEqual(term._back, 6)
        self.assertEqual(term._style, 8)

    @skipUnless(sys.platform.startswith("win"), "requires Windows")
    def testGetAttrs(self):
        term = WinTerm()

        term._fore = 0
        term._back = 0
        term._style = 0
        self.assertEqual(term.get_attrs(), 0)

        term._fore = WinColor.YELLOW
        self.assertEqual(term.get_attrs(), WinColor.YELLOW)

        term._back = WinColor.MAGENTA
        self.assertEqual(
            term.get_attrs(),
            WinColor.YELLOW + WinColor.MAGENTA * 16)

        term._style = WinStyle.BRIGHT
        self.assertEqual(
            term.get_attrs(),
            WinColor.YELLOW + WinColor.MAGENTA * 16 + WinStyle.BRIGHT)

    @patch('colorama.winterm.win32')
    def testResetAll(self, mockWin32):
        mockAttr = Mock()
        mockAttr.wAttributes = 1 + 2 * 16 + 8
        mockWin32.GetConsoleScreenBufferInfo.return_value = mockAttr
        term = WinTerm()

        term.set_console = Mock()
        term._fore = -1
        term._back = -1
        term._style = -1

        term.reset_all()

        self.assertEqual(term._fore, 1)
        self.assertEqual(term._back, 2)
        self.assertEqual(term._style, 8)
        self.assertEqual(term.set_console.called, True)

    @skipUnless(sys.platform.startswith("win"), "requires Windows")
    def testFore(self):
        term = WinTerm()
        term.set_console = Mock()
        term._fore = 0

        term.fore(5)

        self.assertEqual(term._fore, 5)
        self.assertEqual(term.set_console.called, True)

    @skipUnless(sys.platform.startswith("win"), "requires Windows")
    def testBack(self):
        term = WinTerm()
        term.set_console = Mock()
        term._back = 0

        term.back(5)

        self.assertEqual(term._back, 5)
        self.assertEqual(term.set_console.called, True)

    @skipUnless(sys.platform.startswith("win"), "requires Windows")
    def testStyle(self):
        term = WinTerm()
        term.set_console = Mock()
        term._style = 0

        term.style(22)

        self.assertEqual(term._style, 22)
        self.assertEqual(term.set_console.called, True)

    @patch('colorama.winterm.win32')
    def testSetConsole(self, mockWin32):
        mockAttr = Mock()
        mockAttr.wAttributes = 0
        mockWin32.GetConsoleScreenBufferInfo.return_value = mockAttr
        term = WinTerm()
        term.windll = Mock()

        term.set_console()

        self.assertEqual(
            mockWin32.SetConsoleTextAttribute.call_args,
            ((mockWin32.STDOUT, term.get_attrs()), {})
        )

    @patch('colorama.winterm.win32')
    def testSetConsoleOnStderr(self, mockWin32):
        mockAttr = Mock()
        mockAttr.wAttributes = 0
        mockWin32.GetConsoleScreenBufferInfo.return_value = mockAttr
        term = WinTerm()
        term.windll = Mock()

        term.set_console(on_stderr=True)

        self.assertEqual(
            mockWin32.SetConsoleTextAttribute.call_args,
            ((mockWin32.STDERR, term.get_attrs()), {})
        )


if __name__ == '__main__':
    main()
