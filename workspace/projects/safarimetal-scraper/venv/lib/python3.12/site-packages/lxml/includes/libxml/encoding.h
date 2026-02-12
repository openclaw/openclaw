/*
 * Summary: interface for the encoding conversion functions
 * Description: interface for the encoding conversion functions needed for
 *              XML basic encoding and iconv() support.
 *
 * Related specs are
 * rfc2044        (UTF-8 and UTF-16) F. Yergeau Alis Technologies
 * [ISO-10646]    UTF-8 and UTF-16 in Annexes
 * [ISO-8859-1]   ISO Latin-1 characters codes.
 * [UNICODE]      The Unicode Consortium, "The Unicode Standard --
 *                Worldwide Character Encoding -- Version 1.0", Addison-
 *                Wesley, Volume 1, 1991, Volume 2, 1992.  UTF-8 is
 *                described in Unicode Technical Report #4.
 * [US-ASCII]     Coded Character Set--7-bit American Standard Code for
 *                Information Interchange, ANSI X3.4-1986.
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Daniel Veillard
 */

#ifndef __XML_CHAR_ENCODING_H__
#define __XML_CHAR_ENCODING_H__

#include <libxml/xmlversion.h>
#include <libxml/xmlerror.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Backward compatibility
 */
#define UTF8Toisolat1 xmlUTF8ToIsolat1
#define isolat1ToUTF8 xmlIsolat1ToUTF8

typedef enum {
    XML_ENC_ERR_SUCCESS     =  0,
    XML_ENC_ERR_INTERNAL    = -1,
    XML_ENC_ERR_INPUT       = -2,
    XML_ENC_ERR_SPACE       = -3,
    XML_ENC_ERR_MEMORY      = -4
} xmlCharEncError;

/*
 * xmlCharEncoding:
 *
 * Predefined values for some standard encodings.
 */
typedef enum {
    XML_CHAR_ENCODING_ERROR=   -1, /* No char encoding detected */
    XML_CHAR_ENCODING_NONE=	0, /* No char encoding detected */
    XML_CHAR_ENCODING_UTF8=	1, /* UTF-8 */
    XML_CHAR_ENCODING_UTF16LE=	2, /* UTF-16 little endian */
    XML_CHAR_ENCODING_UTF16BE=	3, /* UTF-16 big endian */
    XML_CHAR_ENCODING_UCS4LE=	4, /* UCS-4 little endian */
    XML_CHAR_ENCODING_UCS4BE=	5, /* UCS-4 big endian */
    XML_CHAR_ENCODING_EBCDIC=	6, /* EBCDIC uh! */
    XML_CHAR_ENCODING_UCS4_2143=7, /* UCS-4 unusual ordering */
    XML_CHAR_ENCODING_UCS4_3412=8, /* UCS-4 unusual ordering */
    XML_CHAR_ENCODING_UCS2=	9, /* UCS-2 */
    XML_CHAR_ENCODING_8859_1=	10,/* ISO-8859-1 ISO Latin 1 */
    XML_CHAR_ENCODING_8859_2=	11,/* ISO-8859-2 ISO Latin 2 */
    XML_CHAR_ENCODING_8859_3=	12,/* ISO-8859-3 */
    XML_CHAR_ENCODING_8859_4=	13,/* ISO-8859-4 */
    XML_CHAR_ENCODING_8859_5=	14,/* ISO-8859-5 */
    XML_CHAR_ENCODING_8859_6=	15,/* ISO-8859-6 */
    XML_CHAR_ENCODING_8859_7=	16,/* ISO-8859-7 */
    XML_CHAR_ENCODING_8859_8=	17,/* ISO-8859-8 */
    XML_CHAR_ENCODING_8859_9=	18,/* ISO-8859-9 */
    XML_CHAR_ENCODING_2022_JP=  19,/* ISO-2022-JP */
    XML_CHAR_ENCODING_SHIFT_JIS=20,/* Shift_JIS */
    XML_CHAR_ENCODING_EUC_JP=   21,/* EUC-JP */
    XML_CHAR_ENCODING_ASCII=    22,/* pure ASCII */
    /* Available since 2.14.0 */
    XML_CHAR_ENCODING_UTF16=	23,/* UTF-16 native */
    XML_CHAR_ENCODING_HTML=	24,/* HTML (output only) */
    XML_CHAR_ENCODING_8859_10=	25,/* ISO-8859-10 */
    XML_CHAR_ENCODING_8859_11=	26,/* ISO-8859-11 */
    XML_CHAR_ENCODING_8859_13=	27,/* ISO-8859-13 */
    XML_CHAR_ENCODING_8859_14=	28,/* ISO-8859-14 */
    XML_CHAR_ENCODING_8859_15=	29,/* ISO-8859-15 */
    XML_CHAR_ENCODING_8859_16=	30 /* ISO-8859-16 */
} xmlCharEncoding;

typedef enum {
    XML_ENC_INPUT = (1 << 0),
    XML_ENC_OUTPUT = (1 << 1)
} xmlCharEncFlags;

/**
 * xmlCharEncodingInputFunc:
 * @out:  a pointer to an array of bytes to store the UTF-8 result
 * @outlen:  the length of @out
 * @in:  a pointer to an array of chars in the original encoding
 * @inlen:  the length of @in
 *
 * Convert characters to UTF-8.
 *
 * On success, the value of @inlen after return is the number of
 * bytes consumed and @outlen is the number of bytes produced.
 *
 * Returns the number of bytes written or an XML_ENC_ERR code.
 */
typedef int (*xmlCharEncodingInputFunc)(unsigned char *out, int *outlen,
                                        const unsigned char *in, int *inlen);


/**
 * xmlCharEncodingOutputFunc:
 * @out:  a pointer to an array of bytes to store the result
 * @outlen:  the length of @out
 * @in:  a pointer to an array of UTF-8 chars
 * @inlen:  the length of @in
 *
 * Convert characters from UTF-8.
 *
 * On success, the value of @inlen after return is the number of
 * bytes consumed and @outlen is the number of bytes produced.
 *
 * Returns the number of bytes written or an XML_ENC_ERR code.
 */
typedef int (*xmlCharEncodingOutputFunc)(unsigned char *out, int *outlen,
                                         const unsigned char *in, int *inlen);


/**
 * xmlCharEncConvFunc:
 * @vctxt:  conversion context
 * @out:  a pointer to an array of bytes to store the result
 * @outlen:  the length of @out
 * @in:  a pointer to an array of input bytes
 * @inlen:  the length of @in
 * @flush:  end of input
 *
 * Convert between character encodings.
 *
 * The value of @inlen after return is the number of bytes consumed
 * and @outlen is the number of bytes produced.
 *
 * If the converter can consume partial multi-byte sequences, the
 * @flush flag can be used to detect truncated sequences at EOF.
 * Otherwise, the flag can be ignored.
 *
 * Returns an XML_ENC_ERR code.
 */
typedef xmlCharEncError
(*xmlCharEncConvFunc)(void *vctxt, unsigned char *out, int *outlen,
                      const unsigned char *in, int *inlen, int flush);

/**
 * xmlCharEncConvCtxtDtor:
 * @vctxt:  conversion context
 *
 * Free a conversion context.
 */
typedef void
(*xmlCharEncConvCtxtDtor)(void *vctxt);

/*
 * Block defining the handlers for non UTF-8 encodings.
 *
 * This structure will be made private.
 */
typedef struct _xmlCharEncodingHandler xmlCharEncodingHandler;
typedef xmlCharEncodingHandler *xmlCharEncodingHandlerPtr;
struct _xmlCharEncodingHandler {
    char *name XML_DEPRECATED_MEMBER;
    union {
        xmlCharEncConvFunc func;
        xmlCharEncodingInputFunc legacyFunc;
    } input XML_DEPRECATED_MEMBER;
    union {
        xmlCharEncConvFunc func;
        xmlCharEncodingOutputFunc legacyFunc;
    } output XML_DEPRECATED_MEMBER;
    void *inputCtxt XML_DEPRECATED_MEMBER;
    void *outputCtxt XML_DEPRECATED_MEMBER;
    xmlCharEncConvCtxtDtor ctxtDtor XML_DEPRECATED_MEMBER;
    int flags XML_DEPRECATED_MEMBER;
};

/**
 * xmlCharEncConvImpl:
 * @vctxt:  user data
 * @name:  encoding name
 * @flags:  bit mask of flags
 * @out:  pointer to resulting handler
 *
 * If this function returns XML_ERR_OK, it must fill the @out
 * pointer with an encoding handler. The handler can be obtained
 * from xmlCharEncNewCustomHandler.
 *
 * @flags can contain XML_ENC_INPUT, XML_ENC_OUTPUT or both.
 *
 * Returns an xmlParserErrors code.
 */
typedef xmlParserErrors
(*xmlCharEncConvImpl)(void *vctxt, const char *name, xmlCharEncFlags flags,
                      xmlCharEncodingHandler **out);

/*
 * Interfaces for encoding handlers.
 */
XML_DEPRECATED
XMLPUBFUN void
	xmlInitCharEncodingHandlers	(void);
XML_DEPRECATED
XMLPUBFUN void
	xmlCleanupCharEncodingHandlers	(void);
XMLPUBFUN void
	xmlRegisterCharEncodingHandler	(xmlCharEncodingHandlerPtr handler);
XMLPUBFUN xmlParserErrors
	xmlLookupCharEncodingHandler	(xmlCharEncoding enc,
					 xmlCharEncodingHandlerPtr *out);
XMLPUBFUN xmlParserErrors
	xmlOpenCharEncodingHandler	(const char *name,
					 int output,
					 xmlCharEncodingHandlerPtr *out);
XMLPUBFUN xmlParserErrors
	xmlCreateCharEncodingHandler	(const char *name,
					 xmlCharEncFlags flags,
					 xmlCharEncConvImpl impl,
					 void *implCtxt,
					 xmlCharEncodingHandlerPtr *out);
XMLPUBFUN xmlCharEncodingHandlerPtr
	xmlGetCharEncodingHandler	(xmlCharEncoding enc);
XMLPUBFUN xmlCharEncodingHandlerPtr
	xmlFindCharEncodingHandler	(const char *name);
XMLPUBFUN xmlCharEncodingHandlerPtr
	xmlNewCharEncodingHandler	(const char *name,
					 xmlCharEncodingInputFunc input,
					 xmlCharEncodingOutputFunc output);
XMLPUBFUN xmlParserErrors
	xmlCharEncNewCustomHandler	(const char *name,
					 xmlCharEncConvFunc input,
					 xmlCharEncConvFunc output,
					 xmlCharEncConvCtxtDtor ctxtDtor,
					 void *inputCtxt,
					 void *outputCtxt,
					 xmlCharEncodingHandler **out);

/*
 * Interfaces for encoding names and aliases.
 */
XMLPUBFUN int
	xmlAddEncodingAlias		(const char *name,
					 const char *alias);
XMLPUBFUN int
	xmlDelEncodingAlias		(const char *alias);
XMLPUBFUN const char *
	xmlGetEncodingAlias		(const char *alias);
XMLPUBFUN void
	xmlCleanupEncodingAliases	(void);
XMLPUBFUN xmlCharEncoding
	xmlParseCharEncoding		(const char *name);
XMLPUBFUN const char *
	xmlGetCharEncodingName		(xmlCharEncoding enc);

/*
 * Interfaces directly used by the parsers.
 */
XMLPUBFUN xmlCharEncoding
	xmlDetectCharEncoding		(const unsigned char *in,
					 int len);

/** DOC_DISABLE */
struct _xmlBuffer;
/** DOC_ENABLE */
XMLPUBFUN int
	xmlCharEncOutFunc		(xmlCharEncodingHandler *handler,
					 struct _xmlBuffer *out,
					 struct _xmlBuffer *in);

XMLPUBFUN int
	xmlCharEncInFunc		(xmlCharEncodingHandler *handler,
					 struct _xmlBuffer *out,
					 struct _xmlBuffer *in);
XML_DEPRECATED
XMLPUBFUN int
	xmlCharEncFirstLine		(xmlCharEncodingHandler *handler,
					 struct _xmlBuffer *out,
					 struct _xmlBuffer *in);
XMLPUBFUN int
	xmlCharEncCloseFunc		(xmlCharEncodingHandler *handler);

/*
 * Export a few useful functions
 */
#ifdef LIBXML_OUTPUT_ENABLED
XMLPUBFUN int
	xmlUTF8ToIsolat1		(unsigned char *out,
					 int *outlen,
					 const unsigned char *in,
					 int *inlen);
#endif /* LIBXML_OUTPUT_ENABLED */
XMLPUBFUN int
	xmlIsolat1ToUTF8		(unsigned char *out,
					 int *outlen,
					 const unsigned char *in,
					 int *inlen);
#ifdef __cplusplus
}
#endif

#endif /* __XML_CHAR_ENCODING_H__ */
