/*
 * Summary: interface for the XML entities handling
 * Description: this module provides some of the entity API needed
 *              for the parser and applications.
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Daniel Veillard
 */

#ifndef __XML_ENTITIES_H__
#define __XML_ENTITIES_H__

/** DOC_DISABLE */
#include <libxml/xmlversion.h>
#define XML_TREE_INTERNALS
#include <libxml/tree.h>
#undef XML_TREE_INTERNALS
/** DOC_ENABLE */

#ifdef __cplusplus
extern "C" {
#endif

/*
 * The different valid entity types.
 */
typedef enum {
    XML_INTERNAL_GENERAL_ENTITY = 1,
    XML_EXTERNAL_GENERAL_PARSED_ENTITY = 2,
    XML_EXTERNAL_GENERAL_UNPARSED_ENTITY = 3,
    XML_INTERNAL_PARAMETER_ENTITY = 4,
    XML_EXTERNAL_PARAMETER_ENTITY = 5,
    XML_INTERNAL_PREDEFINED_ENTITY = 6
} xmlEntityType;

/*
 * An unit of storage for an entity, contains the string, the value
 * and the linkind data needed for the linking in the hash table.
 */

struct _xmlEntity {
    void           *_private;	        /* application data */
    xmlElementType          type;       /* XML_ENTITY_DECL, must be second ! */
    const xmlChar          *name;	/* Entity name */
    struct _xmlNode    *children;	/* First child link */
    struct _xmlNode        *last;	/* Last child link */
    struct _xmlDtd       *parent;	/* -> DTD */
    struct _xmlNode        *next;	/* next sibling link  */
    struct _xmlNode        *prev;	/* previous sibling link  */
    struct _xmlDoc          *doc;       /* the containing document */

    xmlChar                *orig;	/* content without ref substitution */
    xmlChar             *content;	/* content or ndata if unparsed */
    int                   length;	/* the content length */
    xmlEntityType          etype;	/* The entity type */
    const xmlChar    *ExternalID;	/* External identifier for PUBLIC */
    const xmlChar      *SystemID;	/* URI for a SYSTEM or PUBLIC Entity */

    struct _xmlEntity     *nexte;	/* unused */
    const xmlChar           *URI;	/* the full URI as computed */
    int                    owner;	/* unused */
    int                    flags;       /* various flags */
    unsigned long   expandedSize;       /* expanded size */
};

/*
 * All entities are stored in an hash table.
 * There is 2 separate hash tables for global and parameter entities.
 */

typedef struct _xmlHashTable xmlEntitiesTable;
typedef xmlEntitiesTable *xmlEntitiesTablePtr;

/*
 * External functions:
 */

XMLPUBFUN xmlEntityPtr
			xmlNewEntity		(xmlDocPtr doc,
						 const xmlChar *name,
						 int type,
						 const xmlChar *ExternalID,
						 const xmlChar *SystemID,
						 const xmlChar *content);
XMLPUBFUN void
			xmlFreeEntity		(xmlEntityPtr entity);
XMLPUBFUN int
			xmlAddEntity		(xmlDocPtr doc,
						 int extSubset,
						 const xmlChar *name,
						 int type,
						 const xmlChar *ExternalID,
						 const xmlChar *SystemID,
						 const xmlChar *content,
						 xmlEntityPtr *out);
XMLPUBFUN xmlEntityPtr
			xmlAddDocEntity		(xmlDocPtr doc,
						 const xmlChar *name,
						 int type,
						 const xmlChar *ExternalID,
						 const xmlChar *SystemID,
						 const xmlChar *content);
XMLPUBFUN xmlEntityPtr
			xmlAddDtdEntity		(xmlDocPtr doc,
						 const xmlChar *name,
						 int type,
						 const xmlChar *ExternalID,
						 const xmlChar *SystemID,
						 const xmlChar *content);
XMLPUBFUN xmlEntityPtr
			xmlGetPredefinedEntity	(const xmlChar *name);
XMLPUBFUN xmlEntityPtr
			xmlGetDocEntity		(const xmlDoc *doc,
						 const xmlChar *name);
XMLPUBFUN xmlEntityPtr
			xmlGetDtdEntity		(xmlDocPtr doc,
						 const xmlChar *name);
XMLPUBFUN xmlEntityPtr
			xmlGetParameterEntity	(xmlDocPtr doc,
						 const xmlChar *name);
XMLPUBFUN xmlChar *
			xmlEncodeEntitiesReentrant(xmlDocPtr doc,
						 const xmlChar *input);
XMLPUBFUN xmlChar *
			xmlEncodeSpecialChars	(const xmlDoc *doc,
						 const xmlChar *input);
XMLPUBFUN xmlEntitiesTablePtr
			xmlCreateEntitiesTable	(void);
XMLPUBFUN xmlEntitiesTablePtr
			xmlCopyEntitiesTable	(xmlEntitiesTablePtr table);
XMLPUBFUN void
			xmlFreeEntitiesTable	(xmlEntitiesTablePtr table);
#ifdef LIBXML_OUTPUT_ENABLED
XMLPUBFUN void
			xmlDumpEntitiesTable	(xmlBufferPtr buf,
						 xmlEntitiesTablePtr table);
XMLPUBFUN void
			xmlDumpEntityDecl	(xmlBufferPtr buf,
						 xmlEntityPtr ent);
#endif /* LIBXML_OUTPUT_ENABLED */

#ifdef __cplusplus
}
#endif

# endif /* __XML_ENTITIES_H__ */
