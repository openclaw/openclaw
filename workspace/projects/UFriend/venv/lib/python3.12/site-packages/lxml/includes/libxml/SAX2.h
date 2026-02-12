/*
 * Summary: SAX2 parser interface used to build the DOM tree
 * Description: those are the default SAX2 interfaces used by
 *              the library when building DOM tree.
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Daniel Veillard
 */


#ifndef __XML_SAX2_H__
#define __XML_SAX2_H__

#include <libxml/xmlversion.h>
#include <libxml/parser.h>

#ifdef __cplusplus
extern "C" {
#endif
XMLPUBFUN const xmlChar *
		xmlSAX2GetPublicId		(void *ctx);
XMLPUBFUN const xmlChar *
		xmlSAX2GetSystemId		(void *ctx);
XMLPUBFUN void
		xmlSAX2SetDocumentLocator	(void *ctx,
						 xmlSAXLocatorPtr loc);

XMLPUBFUN int
		xmlSAX2GetLineNumber		(void *ctx);
XMLPUBFUN int
		xmlSAX2GetColumnNumber		(void *ctx);

XMLPUBFUN int
		xmlSAX2IsStandalone		(void *ctx);
XMLPUBFUN int
		xmlSAX2HasInternalSubset	(void *ctx);
XMLPUBFUN int
		xmlSAX2HasExternalSubset	(void *ctx);

XMLPUBFUN void
		xmlSAX2InternalSubset		(void *ctx,
						 const xmlChar *name,
						 const xmlChar *ExternalID,
						 const xmlChar *SystemID);
XMLPUBFUN void
		xmlSAX2ExternalSubset		(void *ctx,
						 const xmlChar *name,
						 const xmlChar *ExternalID,
						 const xmlChar *SystemID);
XMLPUBFUN xmlEntityPtr
		xmlSAX2GetEntity		(void *ctx,
						 const xmlChar *name);
XMLPUBFUN xmlEntityPtr
		xmlSAX2GetParameterEntity	(void *ctx,
						 const xmlChar *name);
XMLPUBFUN xmlParserInputPtr
		xmlSAX2ResolveEntity		(void *ctx,
						 const xmlChar *publicId,
						 const xmlChar *systemId);

XMLPUBFUN void
		xmlSAX2EntityDecl		(void *ctx,
						 const xmlChar *name,
						 int type,
						 const xmlChar *publicId,
						 const xmlChar *systemId,
						 xmlChar *content);
XMLPUBFUN void
		xmlSAX2AttributeDecl		(void *ctx,
						 const xmlChar *elem,
						 const xmlChar *fullname,
						 int type,
						 int def,
						 const xmlChar *defaultValue,
						 xmlEnumerationPtr tree);
XMLPUBFUN void
		xmlSAX2ElementDecl		(void *ctx,
						 const xmlChar *name,
						 int type,
						 xmlElementContentPtr content);
XMLPUBFUN void
		xmlSAX2NotationDecl		(void *ctx,
						 const xmlChar *name,
						 const xmlChar *publicId,
						 const xmlChar *systemId);
XMLPUBFUN void
		xmlSAX2UnparsedEntityDecl	(void *ctx,
						 const xmlChar *name,
						 const xmlChar *publicId,
						 const xmlChar *systemId,
						 const xmlChar *notationName);

XMLPUBFUN void
		xmlSAX2StartDocument		(void *ctx);
XMLPUBFUN void
		xmlSAX2EndDocument		(void *ctx);
XML_DEPRECATED
XMLPUBFUN void
		xmlSAX2StartElement		(void *ctx,
						 const xmlChar *fullname,
						 const xmlChar **atts);
XML_DEPRECATED
XMLPUBFUN void
		xmlSAX2EndElement		(void *ctx,
						 const xmlChar *name);
XMLPUBFUN void
		xmlSAX2StartElementNs		(void *ctx,
						 const xmlChar *localname,
						 const xmlChar *prefix,
						 const xmlChar *URI,
						 int nb_namespaces,
						 const xmlChar **namespaces,
						 int nb_attributes,
						 int nb_defaulted,
						 const xmlChar **attributes);
XMLPUBFUN void
		xmlSAX2EndElementNs		(void *ctx,
						 const xmlChar *localname,
						 const xmlChar *prefix,
						 const xmlChar *URI);
XMLPUBFUN void
		xmlSAX2Reference		(void *ctx,
						 const xmlChar *name);
XMLPUBFUN void
		xmlSAX2Characters		(void *ctx,
						 const xmlChar *ch,
						 int len);
XMLPUBFUN void
		xmlSAX2IgnorableWhitespace	(void *ctx,
						 const xmlChar *ch,
						 int len);
XMLPUBFUN void
		xmlSAX2ProcessingInstruction	(void *ctx,
						 const xmlChar *target,
						 const xmlChar *data);
XMLPUBFUN void
		xmlSAX2Comment			(void *ctx,
						 const xmlChar *value);
XMLPUBFUN void
		xmlSAX2CDataBlock		(void *ctx,
						 const xmlChar *value,
						 int len);

#ifdef LIBXML_SAX1_ENABLED
XML_DEPRECATED
XMLPUBFUN int
		xmlSAXDefaultVersion		(int version);
#endif /* LIBXML_SAX1_ENABLED */

XMLPUBFUN int
		xmlSAXVersion			(xmlSAXHandler *hdlr,
						 int version);
XMLPUBFUN void
		xmlSAX2InitDefaultSAXHandler    (xmlSAXHandler *hdlr,
						 int warning);
#ifdef LIBXML_HTML_ENABLED
XMLPUBFUN void
		xmlSAX2InitHtmlDefaultSAXHandler(xmlSAXHandler *hdlr);
XML_DEPRECATED
XMLPUBFUN void
		htmlDefaultSAXHandlerInit	(void);
#endif
XML_DEPRECATED
XMLPUBFUN void
		xmlDefaultSAXHandlerInit	(void);
#ifdef __cplusplus
}
#endif
#endif /* __XML_SAX2_H__ */
