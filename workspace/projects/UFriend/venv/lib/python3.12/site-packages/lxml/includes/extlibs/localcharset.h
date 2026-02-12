/* Determine a canonical name for the current locale's character encoding.
   Copyright (C) 2000-2003, 2009-2019 Free Software Foundation, Inc.
   This file is part of the GNU CHARSET Library.

   This program is free software; you can redistribute it and/or modify it
   under the terms of the GNU Lesser General Public License as published
   by the Free Software Foundation; either version 2, or (at your option)
   any later version.

   This program is distributed in the hope that it will be useful,
   but WITHOUT ANY WARRANTY; without even the implied warranty of
   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
   Lesser General Public License for more details.

   You should have received a copy of the GNU Lesser General Public License
   along with this program; if not, see <https://www.gnu.org/licenses/>.  */

#ifndef _LOCALCHARSET_H
#define _LOCALCHARSET_H


#ifdef __cplusplus
extern "C" {
#endif


/* Determine the current locale's character encoding, and canonicalize it
   into one of the canonical names listed below.
   The result must not be freed; it is statically allocated.  The result
   becomes invalid when setlocale() is used to change the global locale, or
   when the value of one of the environment variables LC_ALL, LC_CTYPE, LANG
   is changed; threads in multithreaded programs should not do this.
   If the canonical name cannot be determined, the result is a non-canonical
   name.  */
extern const char * locale_charset (void);

/* About GNU canonical names for character encodings:

   Every canonical name must be supported by GNU libiconv.  Support by GNU libc
   is also desirable.

   The name is case insensitive.  Usually an upper case MIME charset name is
   preferred.

   The current list of these GNU canonical names is:

       name              MIME?             used by which systems
                                    (darwin = Mac OS X, windows = native Windows)

   ASCII, ANSI_X3.4-1968       glibc solaris freebsd netbsd darwin minix cygwin
   ISO-8859-1              Y   glibc aix hpux irix osf solaris freebsd netbsd openbsd darwin cygwin zos
   ISO-8859-2              Y   glibc aix hpux irix osf solaris freebsd netbsd openbsd darwin cygwin zos
   ISO-8859-3              Y   glibc solaris cygwin
   ISO-8859-4              Y   hpux osf solaris freebsd netbsd openbsd darwin
   ISO-8859-5              Y   glibc aix hpux irix osf solaris freebsd netbsd openbsd darwin cygwin zos
   ISO-8859-6              Y   glibc aix hpux solaris cygwin
   ISO-8859-7              Y   glibc aix hpux irix osf solaris freebsd netbsd openbsd darwin cygwin zos
   ISO-8859-8              Y   glibc aix hpux osf solaris cygwin zos
   ISO-8859-9              Y   glibc aix hpux irix osf solaris freebsd darwin cygwin zos
   ISO-8859-13                 glibc hpux solaris freebsd netbsd openbsd darwin cygwin
   ISO-8859-14                 glibc cygwin
   ISO-8859-15                 glibc aix irix osf solaris freebsd netbsd openbsd darwin cygwin
   KOI8-R                  Y   glibc hpux solaris freebsd netbsd openbsd darwin
   KOI8-U                  Y   glibc freebsd netbsd openbsd darwin cygwin
   KOI8-T                      glibc
   CP437                       dos
   CP775                       dos
   CP850                       aix osf dos
   CP852                       dos
   CP855                       dos
   CP856                       aix
   CP857                       dos
   CP861                       dos
   CP862                       dos
   CP864                       dos
   CP865                       dos
   CP866                       freebsd netbsd openbsd darwin dos
   CP869                       dos
   CP874                       windows dos
   CP922                       aix
   CP932                       aix cygwin windows dos
   CP943                       aix zos
   CP949                       osf darwin windows dos
   CP950                       windows dos
   CP1046                      aix
   CP1124                      aix
   CP1125                      dos
   CP1129                      aix
   CP1131                      freebsd darwin
   CP1250                      windows
   CP1251                      glibc hpux solaris freebsd netbsd openbsd darwin cygwin windows
   CP1252                      aix windows
   CP1253                      windows
   CP1254                      windows
   CP1255                      glibc windows
   CP1256                      windows
   CP1257                      windows
   GB2312                  Y   glibc aix hpux irix solaris freebsd netbsd darwin cygwin zos
   EUC-JP                  Y   glibc aix hpux irix osf solaris freebsd netbsd darwin cygwin
   EUC-KR                  Y   glibc aix hpux irix osf solaris freebsd netbsd darwin cygwin zos
   EUC-TW                      glibc aix hpux irix osf solaris netbsd
   BIG5                    Y   glibc aix hpux osf solaris freebsd netbsd darwin cygwin zos
   BIG5-HKSCS                  glibc hpux solaris netbsd darwin
   GBK                         glibc aix osf solaris freebsd darwin cygwin windows dos
   GB18030                     glibc hpux solaris freebsd netbsd darwin
   SHIFT_JIS               Y   hpux osf solaris freebsd netbsd darwin
   JOHAB                       glibc solaris windows
   TIS-620                     glibc aix hpux osf solaris cygwin zos
   VISCII                  Y   glibc
   TCVN5712-1                  glibc
   ARMSCII-8                   glibc freebsd netbsd darwin
   GEORGIAN-PS                 glibc cygwin
   PT154                       glibc netbsd cygwin
   HP-ROMAN8                   hpux
   HP-ARABIC8                  hpux
   HP-GREEK8                   hpux
   HP-HEBREW8                  hpux
   HP-TURKISH8                 hpux
   HP-KANA8                    hpux
   DEC-KANJI                   osf
   DEC-HANYU                   osf
   UTF-8                   Y   glibc aix hpux osf solaris netbsd darwin cygwin zos

   Note: Names which are not marked as being a MIME name should not be used in
   Internet protocols for information interchange (mail, news, etc.).

   Note: ASCII and ANSI_X3.4-1968 are synonymous canonical names.  Applications
   must understand both names and treat them as equivalent.
 */


#ifdef __cplusplus
}
#endif


#endif /* _LOCALCHARSET_H */
