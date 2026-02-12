/**
 * Summary: interfaces to the Catalog handling system
 * Description: the catalog module implements the support for
 * XML Catalogs and SGML catalogs
 *
 * SGML Open Technical Resolution TR9401:1997.
 * http://www.jclark.com/sp/catalog.htm
 *
 * XML Catalogs Working Draft 06 August 2001
 * http://www.oasis-open.org/committees/entity/spec-2001-08-06.html
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Daniel Veillard
 */

#ifndef __XML_CATALOG_H__
#define __XML_CATALOG_H__

#include <stdio.h>

#include <libxml/xmlversion.h>
#include <libxml/xmlstring.h>
#include <libxml/tree.h>

#ifdef LIBXML_CATALOG_ENABLED

#ifdef __cplusplus
extern "C" {
#endif

/**
 * XML_CATALOGS_NAMESPACE:
 *
 * The namespace for the XML Catalogs elements.
 */
#define XML_CATALOGS_NAMESPACE					\
    (const xmlChar *) "urn:oasis:names:tc:entity:xmlns:xml:catalog"
/**
 * XML_CATALOG_PI:
 *
 * The specific XML Catalog Processing Instruction name.
 */
#define XML_CATALOG_PI						\
    (const xmlChar *) "oasis-xml-catalog"

/*
 * The API is voluntarily limited to general cataloging.
 */
typedef enum {
    XML_CATA_PREFER_NONE = 0,
    XML_CATA_PREFER_PUBLIC = 1,
    XML_CATA_PREFER_SYSTEM
} xmlCatalogPrefer;

typedef enum {
    XML_CATA_ALLOW_NONE = 0,
    XML_CATA_ALLOW_GLOBAL = 1,
    XML_CATA_ALLOW_DOCUMENT = 2,
    XML_CATA_ALLOW_ALL = 3
} xmlCatalogAllow;

typedef struct _xmlCatalog xmlCatalog;
typedef xmlCatalog *xmlCatalogPtr;

/*
 * Operations on a given catalog.
 */
XMLPUBFUN xmlCatalogPtr
		xmlNewCatalog		(int sgml);
XMLPUBFUN xmlCatalogPtr
		xmlLoadACatalog		(const char *filename);
XMLPUBFUN xmlCatalogPtr
		xmlLoadSGMLSuperCatalog	(const char *filename);
XMLPUBFUN int
		xmlConvertSGMLCatalog	(xmlCatalogPtr catal);
XMLPUBFUN int
		xmlACatalogAdd		(xmlCatalogPtr catal,
					 const xmlChar *type,
					 const xmlChar *orig,
					 const xmlChar *replace);
XMLPUBFUN int
		xmlACatalogRemove	(xmlCatalogPtr catal,
					 const xmlChar *value);
XMLPUBFUN xmlChar *
		xmlACatalogResolve	(xmlCatalogPtr catal,
					 const xmlChar *pubID,
	                                 const xmlChar *sysID);
XMLPUBFUN xmlChar *
		xmlACatalogResolveSystem(xmlCatalogPtr catal,
					 const xmlChar *sysID);
XMLPUBFUN xmlChar *
		xmlACatalogResolvePublic(xmlCatalogPtr catal,
					 const xmlChar *pubID);
XMLPUBFUN xmlChar *
		xmlACatalogResolveURI	(xmlCatalogPtr catal,
					 const xmlChar *URI);
#ifdef LIBXML_OUTPUT_ENABLED
XMLPUBFUN void
		xmlACatalogDump		(xmlCatalogPtr catal,
					 FILE *out);
#endif /* LIBXML_OUTPUT_ENABLED */
XMLPUBFUN void
		xmlFreeCatalog		(xmlCatalogPtr catal);
XMLPUBFUN int
		xmlCatalogIsEmpty	(xmlCatalogPtr catal);

/*
 * Global operations.
 */
XMLPUBFUN void
		xmlInitializeCatalog	(void);
XMLPUBFUN int
		xmlLoadCatalog		(const char *filename);
XMLPUBFUN void
		xmlLoadCatalogs		(const char *paths);
XMLPUBFUN void
		xmlCatalogCleanup	(void);
#ifdef LIBXML_OUTPUT_ENABLED
XMLPUBFUN void
		xmlCatalogDump		(FILE *out);
#endif /* LIBXML_OUTPUT_ENABLED */
XMLPUBFUN xmlChar *
		xmlCatalogResolve	(const xmlChar *pubID,
	                                 const xmlChar *sysID);
XMLPUBFUN xmlChar *
		xmlCatalogResolveSystem	(const xmlChar *sysID);
XMLPUBFUN xmlChar *
		xmlCatalogResolvePublic	(const xmlChar *pubID);
XMLPUBFUN xmlChar *
		xmlCatalogResolveURI	(const xmlChar *URI);
XMLPUBFUN int
		xmlCatalogAdd		(const xmlChar *type,
					 const xmlChar *orig,
					 const xmlChar *replace);
XMLPUBFUN int
		xmlCatalogRemove	(const xmlChar *value);
XMLPUBFUN xmlDocPtr
		xmlParseCatalogFile	(const char *filename);
XMLPUBFUN int
		xmlCatalogConvert	(void);

/*
 * Strictly minimal interfaces for per-document catalogs used
 * by the parser.
 */
XMLPUBFUN void
		xmlCatalogFreeLocal	(void *catalogs);
XMLPUBFUN void *
		xmlCatalogAddLocal	(void *catalogs,
					 const xmlChar *URL);
XMLPUBFUN xmlChar *
		xmlCatalogLocalResolve	(void *catalogs,
					 const xmlChar *pubID,
	                                 const xmlChar *sysID);
XMLPUBFUN xmlChar *
		xmlCatalogLocalResolveURI(void *catalogs,
					 const xmlChar *URI);
/*
 * Preference settings.
 */
XMLPUBFUN int
		xmlCatalogSetDebug	(int level);
XML_DEPRECATED
XMLPUBFUN xmlCatalogPrefer
		xmlCatalogSetDefaultPrefer(xmlCatalogPrefer prefer);
XMLPUBFUN void
		xmlCatalogSetDefaults	(xmlCatalogAllow allow);
XMLPUBFUN xmlCatalogAllow
		xmlCatalogGetDefaults	(void);


/* DEPRECATED interfaces */
XMLPUBFUN const xmlChar *
		xmlCatalogGetSystem	(const xmlChar *sysID);
XMLPUBFUN const xmlChar *
		xmlCatalogGetPublic	(const xmlChar *pubID);

#ifdef __cplusplus
}
#endif
#endif /* LIBXML_CATALOG_ENABLED */
#endif /* __XML_CATALOG_H__ */
