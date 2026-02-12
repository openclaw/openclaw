/*
 * Summary: internals routines and limits exported by the parser.
 * Description: this module exports a number of internal parsing routines
 *              they are not really all intended for applications but
 *              can prove useful doing low level processing.
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Daniel Veillard
 */

#ifndef __XML_PARSER_INTERNALS_H__
#define __XML_PARSER_INTERNALS_H__

#include <libxml/xmlversion.h>
#include <libxml/parser.h>
#include <libxml/HTMLparser.h>
#include <libxml/chvalid.h>
#include <libxml/SAX2.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Backward compatibility
 */
#define inputPush xmlCtxtPushInput
#define inputPop xmlCtxtPopInput
#define xmlParserMaxDepth 256

/**
 * XML_MAX_TEXT_LENGTH:
 *
 * Maximum size allowed for a single text node when building a tree.
 * This is not a limitation of the parser but a safety boundary feature,
 * use XML_PARSE_HUGE option to override it.
 * Introduced in 2.9.0
 */
#define XML_MAX_TEXT_LENGTH 10000000

/**
 * XML_MAX_HUGE_LENGTH:
 *
 * Maximum size allowed when XML_PARSE_HUGE is set.
 */
#define XML_MAX_HUGE_LENGTH 1000000000

/**
 * XML_MAX_NAME_LENGTH:
 *
 * Maximum size allowed for a markup identifier.
 * This is not a limitation of the parser but a safety boundary feature,
 * use XML_PARSE_HUGE option to override it.
 * Note that with the use of parsing dictionaries overriding the limit
 * may result in more runtime memory usage in face of "unfriendly' content
 * Introduced in 2.9.0
 */
#define XML_MAX_NAME_LENGTH 50000

/**
 * XML_MAX_DICTIONARY_LIMIT:
 *
 * Maximum size allowed by the parser for a dictionary by default
 * This is not a limitation of the parser but a safety boundary feature,
 * use XML_PARSE_HUGE option to override it.
 * Introduced in 2.9.0
 */
#define XML_MAX_DICTIONARY_LIMIT 100000000

/**
 * XML_MAX_LOOKUP_LIMIT:
 *
 * Maximum size allowed by the parser for ahead lookup
 * This is an upper boundary enforced by the parser to avoid bad
 * behaviour on "unfriendly' content
 * Introduced in 2.9.0
 */
#define XML_MAX_LOOKUP_LIMIT 10000000

/**
 * XML_MAX_NAMELEN:
 *
 * Identifiers can be longer, but this will be more costly
 * at runtime.
 */
#define XML_MAX_NAMELEN 100

/************************************************************************
 *									*
 * UNICODE version of the macros.					*
 *									*
 ************************************************************************/
/**
 * IS_BYTE_CHAR:
 * @c:  an byte value (int)
 *
 * Macro to check the following production in the XML spec:
 *
 * [2] Char ::= #x9 | #xA | #xD | [#x20...]
 * any byte character in the accepted range
 */
#define IS_BYTE_CHAR(c)	 xmlIsChar_ch(c)

/**
 * IS_CHAR:
 * @c:  an UNICODE value (int)
 *
 * Macro to check the following production in the XML spec:
 *
 * [2] Char ::= #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD]
 *                  | [#x10000-#x10FFFF]
 * any Unicode character, excluding the surrogate blocks, FFFE, and FFFF.
 */
#define IS_CHAR(c)   xmlIsCharQ(c)

/**
 * IS_CHAR_CH:
 * @c: an xmlChar (usually an unsigned char)
 *
 * Behaves like IS_CHAR on single-byte value
 */
#define IS_CHAR_CH(c)  xmlIsChar_ch(c)

/**
 * IS_BLANK:
 * @c:  an UNICODE value (int)
 *
 * Macro to check the following production in the XML spec:
 *
 * [3] S ::= (#x20 | #x9 | #xD | #xA)+
 */
#define IS_BLANK(c)  xmlIsBlankQ(c)

/**
 * IS_BLANK_CH:
 * @c:  an xmlChar value (normally unsigned char)
 *
 * Behaviour same as IS_BLANK
 */
#define IS_BLANK_CH(c)  xmlIsBlank_ch(c)

/**
 * IS_BASECHAR:
 * @c:  an UNICODE value (int)
 *
 * Macro to check the following production in the XML spec:
 *
 * [85] BaseChar ::= ... long list see REC ...
 */
#define IS_BASECHAR(c) xmlIsBaseCharQ(c)

/**
 * IS_DIGIT:
 * @c:  an UNICODE value (int)
 *
 * Macro to check the following production in the XML spec:
 *
 * [88] Digit ::= ... long list see REC ...
 */
#define IS_DIGIT(c) xmlIsDigitQ(c)

/**
 * IS_DIGIT_CH:
 * @c:  an xmlChar value (usually an unsigned char)
 *
 * Behaves like IS_DIGIT but with a single byte argument
 */
#define IS_DIGIT_CH(c)  xmlIsDigit_ch(c)

/**
 * IS_COMBINING:
 * @c:  an UNICODE value (int)
 *
 * Macro to check the following production in the XML spec:
 *
 * [87] CombiningChar ::= ... long list see REC ...
 */
#define IS_COMBINING(c) xmlIsCombiningQ(c)

/**
 * IS_COMBINING_CH:
 * @c:  an xmlChar (usually an unsigned char)
 *
 * Always false (all combining chars > 0xff)
 */
#define IS_COMBINING_CH(c) 0

/**
 * IS_EXTENDER:
 * @c:  an UNICODE value (int)
 *
 * Macro to check the following production in the XML spec:
 *
 *
 * [89] Extender ::= #x00B7 | #x02D0 | #x02D1 | #x0387 | #x0640 |
 *                   #x0E46 | #x0EC6 | #x3005 | [#x3031-#x3035] |
 *                   [#x309D-#x309E] | [#x30FC-#x30FE]
 */
#define IS_EXTENDER(c) xmlIsExtenderQ(c)

/**
 * IS_EXTENDER_CH:
 * @c:  an xmlChar value (usually an unsigned char)
 *
 * Behaves like IS_EXTENDER but with a single-byte argument
 */
#define IS_EXTENDER_CH(c)  xmlIsExtender_ch(c)

/**
 * IS_IDEOGRAPHIC:
 * @c:  an UNICODE value (int)
 *
 * Macro to check the following production in the XML spec:
 *
 *
 * [86] Ideographic ::= [#x4E00-#x9FA5] | #x3007 | [#x3021-#x3029]
 */
#define IS_IDEOGRAPHIC(c) xmlIsIdeographicQ(c)

/**
 * IS_LETTER:
 * @c:  an UNICODE value (int)
 *
 * Macro to check the following production in the XML spec:
 *
 *
 * [84] Letter ::= BaseChar | Ideographic
 */
#define IS_LETTER(c) (IS_BASECHAR(c) || IS_IDEOGRAPHIC(c))

/**
 * IS_LETTER_CH:
 * @c:  an xmlChar value (normally unsigned char)
 *
 * Macro behaves like IS_LETTER, but only check base chars
 *
 */
#define IS_LETTER_CH(c) xmlIsBaseChar_ch(c)

/**
 * IS_ASCII_LETTER:
 * @c: an xmlChar value
 *
 * Macro to check [a-zA-Z]
 *
 */
#define IS_ASCII_LETTER(c)	((0x61 <= ((c) | 0x20)) && \
                                 (((c) | 0x20) <= 0x7a))

/**
 * IS_ASCII_DIGIT:
 * @c: an xmlChar value
 *
 * Macro to check [0-9]
 *
 */
#define IS_ASCII_DIGIT(c)	((0x30 <= (c)) && ((c) <= 0x39))

/**
 * IS_PUBIDCHAR:
 * @c:  an UNICODE value (int)
 *
 * Macro to check the following production in the XML spec:
 *
 *
 * [13] PubidChar ::= #x20 | #xD | #xA | [a-zA-Z0-9] | [-'()+,./:=?;!*#@$_%]
 */
#define IS_PUBIDCHAR(c)	xmlIsPubidCharQ(c)

/**
 * IS_PUBIDCHAR_CH:
 * @c:  an xmlChar value (normally unsigned char)
 *
 * Same as IS_PUBIDCHAR but for single-byte value
 */
#define IS_PUBIDCHAR_CH(c) xmlIsPubidChar_ch(c)

/**
 * Global variables used for predefined strings.
 */
XMLPUBVAR const xmlChar xmlStringText[];
XMLPUBVAR const xmlChar xmlStringTextNoenc[];
XML_DEPRECATED
XMLPUBVAR const xmlChar xmlStringComment[];

XML_DEPRECATED
XMLPUBFUN int                   xmlIsLetter     (int c);

/**
 * Parser context.
 */
XMLPUBFUN xmlParserCtxtPtr
			xmlCreateFileParserCtxt	(const char *filename);
XMLPUBFUN xmlParserCtxtPtr
			xmlCreateURLParserCtxt	(const char *filename,
						 int options);
XMLPUBFUN xmlParserCtxtPtr
			xmlCreateMemoryParserCtxt(const char *buffer,
						 int size);
XML_DEPRECATED
XMLPUBFUN xmlParserCtxtPtr
			xmlCreateEntityParserCtxt(const xmlChar *URL,
						 const xmlChar *ID,
						 const xmlChar *base);
XMLPUBFUN void
			xmlCtxtErrMemory	(xmlParserCtxtPtr ctxt);
XMLPUBFUN int
			xmlSwitchEncoding	(xmlParserCtxtPtr ctxt,
						 xmlCharEncoding enc);
XMLPUBFUN int
			xmlSwitchEncodingName	(xmlParserCtxtPtr ctxt,
						 const char *encoding);
XMLPUBFUN int
			xmlSwitchToEncoding	(xmlParserCtxtPtr ctxt,
					 xmlCharEncodingHandlerPtr handler);
XML_DEPRECATED
XMLPUBFUN int
			xmlSwitchInputEncoding	(xmlParserCtxtPtr ctxt,
						 xmlParserInputPtr input,
					 xmlCharEncodingHandlerPtr handler);

/**
 * Input Streams.
 */
XMLPUBFUN xmlParserInputPtr
			xmlNewStringInputStream	(xmlParserCtxtPtr ctxt,
						 const xmlChar *buffer);
XML_DEPRECATED
XMLPUBFUN xmlParserInputPtr
			xmlNewEntityInputStream	(xmlParserCtxtPtr ctxt,
						 xmlEntityPtr entity);
XMLPUBFUN int
			xmlCtxtPushInput	(xmlParserCtxtPtr ctxt,
						 xmlParserInputPtr input);
XMLPUBFUN xmlParserInputPtr
			xmlCtxtPopInput		(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN int
			xmlPushInput		(xmlParserCtxtPtr ctxt,
						 xmlParserInputPtr input);
XML_DEPRECATED
XMLPUBFUN xmlChar
			xmlPopInput		(xmlParserCtxtPtr ctxt);
XMLPUBFUN void
			xmlFreeInputStream	(xmlParserInputPtr input);
XMLPUBFUN xmlParserInputPtr
			xmlNewInputFromFile	(xmlParserCtxtPtr ctxt,
						 const char *filename);
XMLPUBFUN xmlParserInputPtr
			xmlNewInputStream	(xmlParserCtxtPtr ctxt);

/**
 * Namespaces.
 */
XMLPUBFUN xmlChar *
			xmlSplitQName		(xmlParserCtxtPtr ctxt,
						 const xmlChar *name,
						 xmlChar **prefix);

/**
 * Generic production rules.
 */
XML_DEPRECATED
XMLPUBFUN const xmlChar *
			xmlParseName		(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN xmlChar *
			xmlParseNmtoken		(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN xmlChar *
			xmlParseEntityValue	(xmlParserCtxtPtr ctxt,
						 xmlChar **orig);
XML_DEPRECATED
XMLPUBFUN xmlChar *
			xmlParseAttValue	(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN xmlChar *
			xmlParseSystemLiteral	(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN xmlChar *
			xmlParsePubidLiteral	(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN void
			xmlParseCharData	(xmlParserCtxtPtr ctxt,
						 int cdata);
XML_DEPRECATED
XMLPUBFUN xmlChar *
			xmlParseExternalID	(xmlParserCtxtPtr ctxt,
						 xmlChar **publicID,
						 int strict);
XML_DEPRECATED
XMLPUBFUN void
			xmlParseComment		(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN const xmlChar *
			xmlParsePITarget	(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN void
			xmlParsePI		(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN void
			xmlParseNotationDecl	(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN void
			xmlParseEntityDecl	(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN int
			xmlParseDefaultDecl	(xmlParserCtxtPtr ctxt,
						 xmlChar **value);
XML_DEPRECATED
XMLPUBFUN xmlEnumerationPtr
			xmlParseNotationType	(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN xmlEnumerationPtr
			xmlParseEnumerationType	(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN int
			xmlParseEnumeratedType	(xmlParserCtxtPtr ctxt,
						 xmlEnumerationPtr *tree);
XML_DEPRECATED
XMLPUBFUN int
			xmlParseAttributeType	(xmlParserCtxtPtr ctxt,
						 xmlEnumerationPtr *tree);
XML_DEPRECATED
XMLPUBFUN void
			xmlParseAttributeListDecl(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN xmlElementContentPtr
			xmlParseElementMixedContentDecl
						(xmlParserCtxtPtr ctxt,
						 int inputchk);
XML_DEPRECATED
XMLPUBFUN xmlElementContentPtr
			xmlParseElementChildrenContentDecl
						(xmlParserCtxtPtr ctxt,
						 int inputchk);
XML_DEPRECATED
XMLPUBFUN int
			xmlParseElementContentDecl(xmlParserCtxtPtr ctxt,
						 const xmlChar *name,
						 xmlElementContentPtr *result);
XML_DEPRECATED
XMLPUBFUN int
			xmlParseElementDecl	(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN void
			xmlParseMarkupDecl	(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN int
			xmlParseCharRef		(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN xmlEntityPtr
			xmlParseEntityRef	(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN void
			xmlParseReference	(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN void
			xmlParsePEReference	(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN void
			xmlParseDocTypeDecl	(xmlParserCtxtPtr ctxt);
#ifdef LIBXML_SAX1_ENABLED
XML_DEPRECATED
XMLPUBFUN const xmlChar *
			xmlParseAttribute	(xmlParserCtxtPtr ctxt,
						 xmlChar **value);
XML_DEPRECATED
XMLPUBFUN const xmlChar *
			xmlParseStartTag	(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN void
			xmlParseEndTag		(xmlParserCtxtPtr ctxt);
#endif /* LIBXML_SAX1_ENABLED */
XML_DEPRECATED
XMLPUBFUN void
			xmlParseCDSect		(xmlParserCtxtPtr ctxt);
XMLPUBFUN void
			xmlParseContent		(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN void
			xmlParseElement		(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN xmlChar *
			xmlParseVersionNum	(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN xmlChar *
			xmlParseVersionInfo	(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN xmlChar *
			xmlParseEncName		(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN const xmlChar *
			xmlParseEncodingDecl	(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN int
			xmlParseSDDecl		(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN void
			xmlParseXMLDecl		(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN void
			xmlParseTextDecl	(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN void
			xmlParseMisc		(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN void
			xmlParseExternalSubset	(xmlParserCtxtPtr ctxt,
						 const xmlChar *ExternalID,
						 const xmlChar *SystemID);
/**
 * XML_SUBSTITUTE_NONE:
 *
 * If no entities need to be substituted.
 */
#define XML_SUBSTITUTE_NONE	0
/**
 * XML_SUBSTITUTE_REF:
 *
 * Whether general entities need to be substituted.
 */
#define XML_SUBSTITUTE_REF	1
/**
 * XML_SUBSTITUTE_PEREF:
 *
 * Whether parameter entities need to be substituted.
 */
#define XML_SUBSTITUTE_PEREF	2
/**
 * XML_SUBSTITUTE_BOTH:
 *
 * Both general and parameter entities need to be substituted.
 */
#define XML_SUBSTITUTE_BOTH	3

XML_DEPRECATED
XMLPUBFUN xmlChar *
		xmlStringDecodeEntities		(xmlParserCtxtPtr ctxt,
						 const xmlChar *str,
						 int what,
						 xmlChar end,
						 xmlChar  end2,
						 xmlChar end3);
XML_DEPRECATED
XMLPUBFUN xmlChar *
		xmlStringLenDecodeEntities	(xmlParserCtxtPtr ctxt,
						 const xmlChar *str,
						 int len,
						 int what,
						 xmlChar end,
						 xmlChar  end2,
						 xmlChar end3);

/*
 * other commodities shared between parser.c and parserInternals.
 */
XML_DEPRECATED
XMLPUBFUN int			xmlSkipBlankChars	(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN int			xmlStringCurrentChar	(xmlParserCtxtPtr ctxt,
						 const xmlChar *cur,
						 int *len);
XML_DEPRECATED
XMLPUBFUN void			xmlParserHandlePEReference(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN int			xmlCheckLanguageID	(const xmlChar *lang);

/*
 * Really core function shared with HTML parser.
 */
XML_DEPRECATED
XMLPUBFUN int			xmlCurrentChar		(xmlParserCtxtPtr ctxt,
						 int *len);
XML_DEPRECATED
XMLPUBFUN int		xmlCopyCharMultiByte	(xmlChar *out,
						 int val);
XML_DEPRECATED
XMLPUBFUN int			xmlCopyChar		(int len,
						 xmlChar *out,
						 int val);
XML_DEPRECATED
XMLPUBFUN void			xmlNextChar		(xmlParserCtxtPtr ctxt);
XML_DEPRECATED
XMLPUBFUN void			xmlParserInputShrink	(xmlParserInputPtr in);

#ifdef __cplusplus
}
#endif
#endif /* __XML_PARSER_INTERNALS_H__ */
