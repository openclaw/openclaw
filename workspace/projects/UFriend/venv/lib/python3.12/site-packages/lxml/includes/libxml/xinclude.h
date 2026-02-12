/*
 * Summary: implementation of XInclude
 * Description: API to handle XInclude processing,
 * implements the
 * World Wide Web Consortium Last Call Working Draft 10 November 2003
 * http://www.w3.org/TR/2003/WD-xinclude-20031110
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Daniel Veillard
 */

#ifndef __XML_XINCLUDE_H__
#define __XML_XINCLUDE_H__

#include <libxml/xmlversion.h>
#include <libxml/xmlerror.h>
#include <libxml/tree.h>
#include <libxml/parser.h>

#ifdef LIBXML_XINCLUDE_ENABLED

#ifdef __cplusplus
extern "C" {
#endif

/**
 * XINCLUDE_NS:
 *
 * Macro defining the Xinclude namespace: http://www.w3.org/2003/XInclude
 */
#define XINCLUDE_NS (const xmlChar *) "http://www.w3.org/2003/XInclude"
/**
 * XINCLUDE_OLD_NS:
 *
 * Macro defining the draft Xinclude namespace: http://www.w3.org/2001/XInclude
 */
#define XINCLUDE_OLD_NS (const xmlChar *) "http://www.w3.org/2001/XInclude"
/**
 * XINCLUDE_NODE:
 *
 * Macro defining "include"
 */
#define XINCLUDE_NODE (const xmlChar *) "include"
/**
 * XINCLUDE_FALLBACK:
 *
 * Macro defining "fallback"
 */
#define XINCLUDE_FALLBACK (const xmlChar *) "fallback"
/**
 * XINCLUDE_HREF:
 *
 * Macro defining "href"
 */
#define XINCLUDE_HREF (const xmlChar *) "href"
/**
 * XINCLUDE_PARSE:
 *
 * Macro defining "parse"
 */
#define XINCLUDE_PARSE (const xmlChar *) "parse"
/**
 * XINCLUDE_PARSE_XML:
 *
 * Macro defining "xml"
 */
#define XINCLUDE_PARSE_XML (const xmlChar *) "xml"
/**
 * XINCLUDE_PARSE_TEXT:
 *
 * Macro defining "text"
 */
#define XINCLUDE_PARSE_TEXT (const xmlChar *) "text"
/**
 * XINCLUDE_PARSE_ENCODING:
 *
 * Macro defining "encoding"
 */
#define XINCLUDE_PARSE_ENCODING (const xmlChar *) "encoding"
/**
 * XINCLUDE_PARSE_XPOINTER:
 *
 * Macro defining "xpointer"
 */
#define XINCLUDE_PARSE_XPOINTER (const xmlChar *) "xpointer"

typedef struct _xmlXIncludeCtxt xmlXIncludeCtxt;
typedef xmlXIncludeCtxt *xmlXIncludeCtxtPtr;

/*
 * standalone processing
 */
XMLPUBFUN int
		xmlXIncludeProcess	(xmlDocPtr doc);
XMLPUBFUN int
		xmlXIncludeProcessFlags	(xmlDocPtr doc,
					 int flags);
XMLPUBFUN int
		xmlXIncludeProcessFlagsData(xmlDocPtr doc,
					 int flags,
					 void *data);
XMLPUBFUN int
                xmlXIncludeProcessTreeFlagsData(xmlNodePtr tree,
                                         int flags,
                                         void *data);
XMLPUBFUN int
		xmlXIncludeProcessTree	(xmlNodePtr tree);
XMLPUBFUN int
		xmlXIncludeProcessTreeFlags(xmlNodePtr tree,
					 int flags);
/*
 * contextual processing
 */
XMLPUBFUN xmlXIncludeCtxtPtr
		xmlXIncludeNewContext	(xmlDocPtr doc);
XMLPUBFUN int
		xmlXIncludeSetFlags	(xmlXIncludeCtxtPtr ctxt,
					 int flags);
XMLPUBFUN void
		xmlXIncludeSetErrorHandler(xmlXIncludeCtxtPtr ctxt,
					 xmlStructuredErrorFunc handler,
					 void *data);
XMLPUBFUN void
		xmlXIncludeSetResourceLoader(xmlXIncludeCtxtPtr ctxt,
					 xmlResourceLoader loader,
					 void *data);
XMLPUBFUN int
		xmlXIncludeGetLastError	(xmlXIncludeCtxtPtr ctxt);
XMLPUBFUN void
		xmlXIncludeFreeContext	(xmlXIncludeCtxtPtr ctxt);
XMLPUBFUN int
		xmlXIncludeProcessNode	(xmlXIncludeCtxtPtr ctxt,
					 xmlNodePtr tree);
#ifdef __cplusplus
}
#endif

#endif /* LIBXML_XINCLUDE_ENABLED */

#endif /* __XML_XINCLUDE_H__ */
