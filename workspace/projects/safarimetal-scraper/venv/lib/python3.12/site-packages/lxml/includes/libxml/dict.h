/*
 * Summary: string dictionary
 * Description: dictionary of reusable strings, just used to avoid allocation
 *         and freeing operations.
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Daniel Veillard
 */

#ifndef __XML_DICT_H__
#define __XML_DICT_H__

#include <stddef.h>
#include <libxml/xmlversion.h>
#include <libxml/xmlstring.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * The dictionary.
 */
typedef struct _xmlDict xmlDict;
typedef xmlDict *xmlDictPtr;

/*
 * Initializer
 */
XML_DEPRECATED
XMLPUBFUN int  xmlInitializeDict(void);

/*
 * Constructor and destructor.
 */
XMLPUBFUN xmlDictPtr
			xmlDictCreate	(void);
XMLPUBFUN size_t
			xmlDictSetLimit	(xmlDictPtr dict,
                                         size_t limit);
XMLPUBFUN size_t
			xmlDictGetUsage (xmlDictPtr dict);
XMLPUBFUN xmlDictPtr
			xmlDictCreateSub(xmlDictPtr sub);
XMLPUBFUN int
			xmlDictReference(xmlDictPtr dict);
XMLPUBFUN void
			xmlDictFree	(xmlDictPtr dict);

/*
 * Lookup of entry in the dictionary.
 */
XMLPUBFUN const xmlChar *
			xmlDictLookup	(xmlDictPtr dict,
		                         const xmlChar *name,
		                         int len);
XMLPUBFUN const xmlChar *
			xmlDictExists	(xmlDictPtr dict,
		                         const xmlChar *name,
		                         int len);
XMLPUBFUN const xmlChar *
			xmlDictQLookup	(xmlDictPtr dict,
		                         const xmlChar *prefix,
		                         const xmlChar *name);
XMLPUBFUN int
			xmlDictOwns	(xmlDictPtr dict,
					 const xmlChar *str);
XMLPUBFUN int
			xmlDictSize	(xmlDictPtr dict);

/*
 * Cleanup function
 */
XML_DEPRECATED
XMLPUBFUN void
                        xmlDictCleanup  (void);

#ifdef __cplusplus
}
#endif
#endif /* ! __XML_DICT_H__ */
