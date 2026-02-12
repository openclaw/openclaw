/*
 * Summary: Tree debugging APIs
 * Description: Interfaces to a set of routines used for debugging the tree
 *              produced by the XML parser.
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Daniel Veillard
 */

#ifndef __DEBUG_XML__
#define __DEBUG_XML__
#include <stdio.h>
#include <libxml/xmlversion.h>
#include <libxml/tree.h>

#ifdef LIBXML_DEBUG_ENABLED

#include <libxml/xpath.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * The standard Dump routines.
 */
XMLPUBFUN void
	xmlDebugDumpString	(FILE *output,
				 const xmlChar *str);
XMLPUBFUN void
	xmlDebugDumpAttr	(FILE *output,
				 xmlAttrPtr attr,
				 int depth);
XMLPUBFUN void
	xmlDebugDumpAttrList	(FILE *output,
				 xmlAttrPtr attr,
				 int depth);
XMLPUBFUN void
	xmlDebugDumpOneNode	(FILE *output,
				 xmlNodePtr node,
				 int depth);
XMLPUBFUN void
	xmlDebugDumpNode	(FILE *output,
				 xmlNodePtr node,
				 int depth);
XMLPUBFUN void
	xmlDebugDumpNodeList	(FILE *output,
				 xmlNodePtr node,
				 int depth);
XMLPUBFUN void
	xmlDebugDumpDocumentHead(FILE *output,
				 xmlDocPtr doc);
XMLPUBFUN void
	xmlDebugDumpDocument	(FILE *output,
				 xmlDocPtr doc);
XMLPUBFUN void
	xmlDebugDumpDTD		(FILE *output,
				 xmlDtdPtr dtd);
XMLPUBFUN void
	xmlDebugDumpEntities	(FILE *output,
				 xmlDocPtr doc);

/****************************************************************
 *								*
 *			Checking routines			*
 *								*
 ****************************************************************/

XMLPUBFUN int
	xmlDebugCheckDocument	(FILE * output,
				 xmlDocPtr doc);

#ifdef __cplusplus
}
#endif

#endif /* LIBXML_DEBUG_ENABLED */
#endif /* __DEBUG_XML__ */
