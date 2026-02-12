/*
 * Summary: implementation of XML Schema Datatypes
 * Description: module providing the XML Schema Datatypes implementation
 *              both definition and validity checking
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Daniel Veillard
 */


#ifndef __XML_SCHEMA_TYPES_H__
#define __XML_SCHEMA_TYPES_H__

#include <libxml/xmlversion.h>

#ifdef LIBXML_SCHEMAS_ENABLED

#include <libxml/schemasInternals.h>
#include <libxml/xmlschemas.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    XML_SCHEMA_WHITESPACE_UNKNOWN = 0,
    XML_SCHEMA_WHITESPACE_PRESERVE = 1,
    XML_SCHEMA_WHITESPACE_REPLACE = 2,
    XML_SCHEMA_WHITESPACE_COLLAPSE = 3
} xmlSchemaWhitespaceValueType;

XMLPUBFUN int
		xmlSchemaInitTypes		(void);
XML_DEPRECATED
XMLPUBFUN void
		xmlSchemaCleanupTypes		(void);
XMLPUBFUN xmlSchemaTypePtr
		xmlSchemaGetPredefinedType	(const xmlChar *name,
						 const xmlChar *ns);
XMLPUBFUN int
		xmlSchemaValidatePredefinedType	(xmlSchemaTypePtr type,
						 const xmlChar *value,
						 xmlSchemaValPtr *val);
XMLPUBFUN int
		xmlSchemaValPredefTypeNode	(xmlSchemaTypePtr type,
						 const xmlChar *value,
						 xmlSchemaValPtr *val,
						 xmlNodePtr node);
XMLPUBFUN int
		xmlSchemaValidateFacet		(xmlSchemaTypePtr base,
						 xmlSchemaFacetPtr facet,
						 const xmlChar *value,
						 xmlSchemaValPtr val);
XMLPUBFUN int
		xmlSchemaValidateFacetWhtsp	(xmlSchemaFacetPtr facet,
						 xmlSchemaWhitespaceValueType fws,
						 xmlSchemaValType valType,
						 const xmlChar *value,
						 xmlSchemaValPtr val,
						 xmlSchemaWhitespaceValueType ws);
XMLPUBFUN void
		xmlSchemaFreeValue		(xmlSchemaValPtr val);
XMLPUBFUN xmlSchemaFacetPtr
		xmlSchemaNewFacet		(void);
XMLPUBFUN int
		xmlSchemaCheckFacet		(xmlSchemaFacetPtr facet,
						 xmlSchemaTypePtr typeDecl,
						 xmlSchemaParserCtxtPtr ctxt,
						 const xmlChar *name);
XMLPUBFUN void
		xmlSchemaFreeFacet		(xmlSchemaFacetPtr facet);
XMLPUBFUN int
		xmlSchemaCompareValues		(xmlSchemaValPtr x,
						 xmlSchemaValPtr y);
XMLPUBFUN xmlSchemaTypePtr
    xmlSchemaGetBuiltInListSimpleTypeItemType	(xmlSchemaTypePtr type);
XMLPUBFUN int
    xmlSchemaValidateListSimpleTypeFacet	(xmlSchemaFacetPtr facet,
						 const xmlChar *value,
						 unsigned long actualLen,
						 unsigned long *expectedLen);
XMLPUBFUN xmlSchemaTypePtr
		xmlSchemaGetBuiltInType		(xmlSchemaValType type);
XMLPUBFUN int
		xmlSchemaIsBuiltInTypeFacet	(xmlSchemaTypePtr type,
						 int facetType);
XMLPUBFUN xmlChar *
		xmlSchemaCollapseString		(const xmlChar *value);
XMLPUBFUN xmlChar *
		xmlSchemaWhiteSpaceReplace	(const xmlChar *value);
XMLPUBFUN unsigned long 
		xmlSchemaGetFacetValueAsULong	(xmlSchemaFacetPtr facet);
XMLPUBFUN int
		xmlSchemaValidateLengthFacet	(xmlSchemaTypePtr type,
						 xmlSchemaFacetPtr facet,
						 const xmlChar *value,
						 xmlSchemaValPtr val,
						 unsigned long *length);
XMLPUBFUN int
		xmlSchemaValidateLengthFacetWhtsp(xmlSchemaFacetPtr facet,
						  xmlSchemaValType valType,
						  const xmlChar *value,
						  xmlSchemaValPtr val,
						  unsigned long *length,
						  xmlSchemaWhitespaceValueType ws);
XMLPUBFUN int
		xmlSchemaValPredefTypeNodeNoNorm(xmlSchemaTypePtr type,
						 const xmlChar *value,
						 xmlSchemaValPtr *val,
						 xmlNodePtr node);
XMLPUBFUN int
		xmlSchemaGetCanonValue		(xmlSchemaValPtr val,
						 const xmlChar **retValue);
XMLPUBFUN int
		xmlSchemaGetCanonValueWhtsp	(xmlSchemaValPtr val,
						 const xmlChar **retValue,
						 xmlSchemaWhitespaceValueType ws);
XMLPUBFUN int
		xmlSchemaValueAppend		(xmlSchemaValPtr prev,
						 xmlSchemaValPtr cur);
XMLPUBFUN xmlSchemaValPtr
		xmlSchemaValueGetNext		(xmlSchemaValPtr cur);
XMLPUBFUN const xmlChar *
		xmlSchemaValueGetAsString	(xmlSchemaValPtr val);
XMLPUBFUN int
		xmlSchemaValueGetAsBoolean	(xmlSchemaValPtr val);
XMLPUBFUN xmlSchemaValPtr
		xmlSchemaNewStringValue		(xmlSchemaValType type,
						 const xmlChar *value);
XMLPUBFUN xmlSchemaValPtr
		xmlSchemaNewNOTATIONValue	(const xmlChar *name,
						 const xmlChar *ns);
XMLPUBFUN xmlSchemaValPtr
		xmlSchemaNewQNameValue		(const xmlChar *namespaceName,
						 const xmlChar *localName);
XMLPUBFUN int
		xmlSchemaCompareValuesWhtsp	(xmlSchemaValPtr x,
						 xmlSchemaWhitespaceValueType xws,
						 xmlSchemaValPtr y,
						 xmlSchemaWhitespaceValueType yws);
XMLPUBFUN xmlSchemaValPtr
		xmlSchemaCopyValue		(xmlSchemaValPtr val);
XMLPUBFUN xmlSchemaValType
		xmlSchemaGetValType		(xmlSchemaValPtr val);

#ifdef __cplusplus
}
#endif

#endif /* LIBXML_SCHEMAS_ENABLED */
#endif /* __XML_SCHEMA_TYPES_H__ */
