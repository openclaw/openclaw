/*
 * Summary: the XML document serializer
 * Description: API to save document or subtree of document
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Daniel Veillard
 */

#ifndef __XML_XMLSAVE_H__
#define __XML_XMLSAVE_H__

#include <libxml/xmlversion.h>
#include <libxml/tree.h>
#include <libxml/encoding.h>
#include <libxml/xmlIO.h>

#ifdef LIBXML_OUTPUT_ENABLED
#ifdef __cplusplus
extern "C" {
#endif

/**
 * xmlSaveOption:
 *
 * This is the set of XML save options that can be passed down
 * to the xmlSaveToFd() and similar calls.
 */
typedef enum {
    XML_SAVE_FORMAT     = 1<<0,	/* format save output */
    XML_SAVE_NO_DECL    = 1<<1,	/* drop the xml declaration */
    XML_SAVE_NO_EMPTY	= 1<<2, /* no empty tags */
    XML_SAVE_NO_XHTML	= 1<<3, /* disable XHTML1 specific rules */
    XML_SAVE_XHTML	= 1<<4, /* force XHTML1 specific rules */
    XML_SAVE_AS_XML     = 1<<5, /* force XML serialization on HTML doc */
    XML_SAVE_AS_HTML    = 1<<6, /* force HTML serialization on XML doc */
    XML_SAVE_WSNONSIG   = 1<<7, /* format with non-significant whitespace */
    /* Available since 2.14.0 */
    XML_SAVE_EMPTY      = 1<<8, /* force empty tags, overriding global */
    XML_SAVE_NO_INDENT  = 1<<9, /* disable indenting */
    XML_SAVE_INDENT     = 1<<10 /* force indenting, overriding global */
} xmlSaveOption;


typedef struct _xmlSaveCtxt xmlSaveCtxt;
typedef xmlSaveCtxt *xmlSaveCtxtPtr;

XMLPUBFUN xmlSaveCtxtPtr
		xmlSaveToFd		(int fd,
					 const char *encoding,
					 int options);
XMLPUBFUN xmlSaveCtxtPtr
		xmlSaveToFilename	(const char *filename,
					 const char *encoding,
					 int options);

XMLPUBFUN xmlSaveCtxtPtr
		xmlSaveToBuffer		(xmlBufferPtr buffer,
					 const char *encoding,
					 int options);

XMLPUBFUN xmlSaveCtxtPtr
		xmlSaveToIO		(xmlOutputWriteCallback iowrite,
					 xmlOutputCloseCallback ioclose,
					 void *ioctx,
					 const char *encoding,
					 int options);

XMLPUBFUN long
		xmlSaveDoc		(xmlSaveCtxtPtr ctxt,
					 xmlDocPtr doc);
XMLPUBFUN long
		xmlSaveTree		(xmlSaveCtxtPtr ctxt,
					 xmlNodePtr node);

XMLPUBFUN int
		xmlSaveFlush		(xmlSaveCtxtPtr ctxt);
XMLPUBFUN int
		xmlSaveClose		(xmlSaveCtxtPtr ctxt);
XMLPUBFUN xmlParserErrors
		xmlSaveFinish		(xmlSaveCtxtPtr ctxt);
XMLPUBFUN int
		xmlSaveSetIndentString	(xmlSaveCtxtPtr ctxt,
					 const char *indent);
XML_DEPRECATED
XMLPUBFUN int
		xmlSaveSetEscape	(xmlSaveCtxtPtr ctxt,
					 xmlCharEncodingOutputFunc escape);
XML_DEPRECATED
XMLPUBFUN int
		xmlSaveSetAttrEscape	(xmlSaveCtxtPtr ctxt,
					 xmlCharEncodingOutputFunc escape);

XML_DEPRECATED
XMLPUBFUN int
                xmlThrDefIndentTreeOutput(int v);
XML_DEPRECATED
XMLPUBFUN const char *
                xmlThrDefTreeIndentString(const char * v);
XML_DEPRECATED
XMLPUBFUN int
                xmlThrDefSaveNoEmptyTags(int v);

#ifdef __cplusplus
}
#endif

#endif /* LIBXML_OUTPUT_ENABLED */
#endif /* __XML_XMLSAVE_H__ */


