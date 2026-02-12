/*
 * Summary: specific APIs to process HTML tree, especially serialization
 * Description: this module implements a few function needed to process
 *              tree in an HTML specific way.
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Daniel Veillard
 */

#ifndef __HTML_TREE_H__
#define __HTML_TREE_H__

#include <stdio.h>
#include <libxml/xmlversion.h>
#include <libxml/tree.h>
#include <libxml/HTMLparser.h>

#ifdef LIBXML_HTML_ENABLED

#ifdef __cplusplus
extern "C" {
#endif


/**
 * HTML_TEXT_NODE:
 *
 * Macro. A text node in a HTML document is really implemented
 * the same way as a text node in an XML document.
 */
#define HTML_TEXT_NODE		XML_TEXT_NODE
/**
 * HTML_ENTITY_REF_NODE:
 *
 * Macro. An entity reference in a HTML document is really implemented
 * the same way as an entity reference in an XML document.
 */
#define HTML_ENTITY_REF_NODE	XML_ENTITY_REF_NODE
/**
 * HTML_COMMENT_NODE:
 *
 * Macro. A comment in a HTML document is really implemented
 * the same way as a comment in an XML document.
 */
#define HTML_COMMENT_NODE	XML_COMMENT_NODE
/**
 * HTML_PRESERVE_NODE:
 *
 * Macro. A preserved node in a HTML document is really implemented
 * the same way as a CDATA section in an XML document.
 */
#define HTML_PRESERVE_NODE	XML_CDATA_SECTION_NODE
/**
 * HTML_PI_NODE:
 *
 * Macro. A processing instruction in a HTML document is really implemented
 * the same way as a processing instruction in an XML document.
 */
#define HTML_PI_NODE		XML_PI_NODE

XMLPUBFUN htmlDocPtr
		htmlNewDoc		(const xmlChar *URI,
					 const xmlChar *ExternalID);
XMLPUBFUN htmlDocPtr
		htmlNewDocNoDtD		(const xmlChar *URI,
					 const xmlChar *ExternalID);
XMLPUBFUN const xmlChar *
		htmlGetMetaEncoding	(htmlDocPtr doc);
XMLPUBFUN int
		htmlSetMetaEncoding	(htmlDocPtr doc,
					 const xmlChar *encoding);
#ifdef LIBXML_OUTPUT_ENABLED
XMLPUBFUN void
		htmlDocDumpMemory	(xmlDocPtr cur,
					 xmlChar **mem,
					 int *size);
XMLPUBFUN void
		htmlDocDumpMemoryFormat	(xmlDocPtr cur,
					 xmlChar **mem,
					 int *size,
					 int format);
XMLPUBFUN int
		htmlDocDump		(FILE *f,
					 xmlDocPtr cur);
XMLPUBFUN int
		htmlSaveFile		(const char *filename,
					 xmlDocPtr cur);
XMLPUBFUN int
		htmlNodeDump		(xmlBufferPtr buf,
					 xmlDocPtr doc,
					 xmlNodePtr cur);
XMLPUBFUN void
		htmlNodeDumpFile	(FILE *out,
					 xmlDocPtr doc,
					 xmlNodePtr cur);
XMLPUBFUN int
		htmlNodeDumpFileFormat	(FILE *out,
					 xmlDocPtr doc,
					 xmlNodePtr cur,
					 const char *encoding,
					 int format);
XMLPUBFUN int
		htmlSaveFileEnc		(const char *filename,
					 xmlDocPtr cur,
					 const char *encoding);
XMLPUBFUN int
		htmlSaveFileFormat	(const char *filename,
					 xmlDocPtr cur,
					 const char *encoding,
					 int format);

XMLPUBFUN void
		htmlNodeDumpFormatOutput(xmlOutputBufferPtr buf,
					 xmlDocPtr doc,
					 xmlNodePtr cur,
					 const char *encoding,
					 int format);
XMLPUBFUN void
		htmlDocContentDumpOutput(xmlOutputBufferPtr buf,
					 xmlDocPtr cur,
					 const char *encoding);
XMLPUBFUN void
		htmlDocContentDumpFormatOutput(xmlOutputBufferPtr buf,
					 xmlDocPtr cur,
					 const char *encoding,
					 int format);
XMLPUBFUN void
		htmlNodeDumpOutput	(xmlOutputBufferPtr buf,
					 xmlDocPtr doc,
					 xmlNodePtr cur,
					 const char *encoding);

#endif /* LIBXML_OUTPUT_ENABLED */

XML_DEPRECATED
XMLPUBFUN int
		htmlIsBooleanAttr	(const xmlChar *name);


#ifdef __cplusplus
}
#endif

#endif /* LIBXML_HTML_ENABLED */

#endif /* __HTML_TREE_H__ */

