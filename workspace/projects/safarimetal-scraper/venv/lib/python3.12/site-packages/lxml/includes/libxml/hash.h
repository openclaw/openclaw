/*
 * Summary: Chained hash tables
 * Description: This module implements the hash table support used in
 *		various places in the library.
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Bjorn Reese <bjorn.reese@systematic.dk>
 */

#ifndef __XML_HASH_H__
#define __XML_HASH_H__

#include <libxml/xmlversion.h>
#include <libxml/dict.h>
#include <libxml/xmlstring.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * The hash table.
 */
typedef struct _xmlHashTable xmlHashTable;
typedef xmlHashTable *xmlHashTablePtr;

/*
 * Recent version of gcc produce a warning when a function pointer is assigned
 * to an object pointer, or vice versa.  The following macro is a dirty hack
 * to allow suppression of the warning.  If your architecture has function
 * pointers which are a different size than a void pointer, there may be some
 * serious trouble within the library.
 */
/**
 * XML_CAST_FPTR:
 * @fptr:  pointer to a function
 *
 * Macro to do a casting from an object pointer to a
 * function pointer without encountering a warning from
 * gcc
 *
 * #define XML_CAST_FPTR(fptr) (*(void **)(&fptr))
 * This macro violated ISO C aliasing rules (gcc4 on s390 broke)
 * so it is disabled now
 */

#define XML_CAST_FPTR(fptr) fptr

/*
 * function types:
 */
/**
 * xmlHashDeallocator:
 * @payload:  the data in the hash
 * @name:  the name associated
 *
 * Callback to free data from a hash.
 */
typedef void (*xmlHashDeallocator)(void *payload, const xmlChar *name);
/**
 * xmlHashCopier:
 * @payload:  the data in the hash
 * @name:  the name associated
 *
 * Callback to copy data from a hash.
 *
 * Returns a copy of the data or NULL in case of error.
 */
typedef void *(*xmlHashCopier)(void *payload, const xmlChar *name);
/**
 * xmlHashScanner:
 * @payload:  the data in the hash
 * @data:  extra scanner data
 * @name:  the name associated
 *
 * Callback when scanning data in a hash with the simple scanner.
 */
typedef void (*xmlHashScanner)(void *payload, void *data, const xmlChar *name);
/**
 * xmlHashScannerFull:
 * @payload:  the data in the hash
 * @data:  extra scanner data
 * @name:  the name associated
 * @name2:  the second name associated
 * @name3:  the third name associated
 *
 * Callback when scanning data in a hash with the full scanner.
 */
typedef void (*xmlHashScannerFull)(void *payload, void *data,
				   const xmlChar *name, const xmlChar *name2,
				   const xmlChar *name3);

/*
 * Constructor and destructor.
 */
XMLPUBFUN xmlHashTablePtr
		xmlHashCreate		(int size);
XMLPUBFUN xmlHashTablePtr
		xmlHashCreateDict	(int size,
					 xmlDictPtr dict);
XMLPUBFUN void
		xmlHashFree		(xmlHashTablePtr hash,
					 xmlHashDeallocator dealloc);
XMLPUBFUN void
		xmlHashDefaultDeallocator(void *entry,
					 const xmlChar *name);

/*
 * Add a new entry to the hash table.
 */
XMLPUBFUN int
		xmlHashAdd		(xmlHashTablePtr hash,
		                         const xmlChar *name,
		                         void *userdata);
XMLPUBFUN int
		xmlHashAddEntry		(xmlHashTablePtr hash,
		                         const xmlChar *name,
		                         void *userdata);
XMLPUBFUN int
		xmlHashUpdateEntry	(xmlHashTablePtr hash,
		                         const xmlChar *name,
		                         void *userdata,
					 xmlHashDeallocator dealloc);
XMLPUBFUN int
		xmlHashAdd2		(xmlHashTablePtr hash,
		                         const xmlChar *name,
		                         const xmlChar *name2,
		                         void *userdata);
XMLPUBFUN int
		xmlHashAddEntry2	(xmlHashTablePtr hash,
		                         const xmlChar *name,
		                         const xmlChar *name2,
		                         void *userdata);
XMLPUBFUN int
		xmlHashUpdateEntry2	(xmlHashTablePtr hash,
		                         const xmlChar *name,
		                         const xmlChar *name2,
		                         void *userdata,
					 xmlHashDeallocator dealloc);
XMLPUBFUN int
		xmlHashAdd3		(xmlHashTablePtr hash,
		                         const xmlChar *name,
		                         const xmlChar *name2,
		                         const xmlChar *name3,
		                         void *userdata);
XMLPUBFUN int
		xmlHashAddEntry3	(xmlHashTablePtr hash,
		                         const xmlChar *name,
		                         const xmlChar *name2,
		                         const xmlChar *name3,
		                         void *userdata);
XMLPUBFUN int
		xmlHashUpdateEntry3	(xmlHashTablePtr hash,
		                         const xmlChar *name,
		                         const xmlChar *name2,
		                         const xmlChar *name3,
		                         void *userdata,
					 xmlHashDeallocator dealloc);

/*
 * Remove an entry from the hash table.
 */
XMLPUBFUN int
		xmlHashRemoveEntry	(xmlHashTablePtr hash,
					 const xmlChar *name,
					 xmlHashDeallocator dealloc);
XMLPUBFUN int
		xmlHashRemoveEntry2	(xmlHashTablePtr hash,
					 const xmlChar *name,
					 const xmlChar *name2,
					 xmlHashDeallocator dealloc);
XMLPUBFUN int 
		xmlHashRemoveEntry3	(xmlHashTablePtr hash,
					 const xmlChar *name,
					 const xmlChar *name2,
					 const xmlChar *name3,
					 xmlHashDeallocator dealloc);

/*
 * Retrieve the payload.
 */
XMLPUBFUN void *
		xmlHashLookup		(xmlHashTablePtr hash,
					 const xmlChar *name);
XMLPUBFUN void *
		xmlHashLookup2		(xmlHashTablePtr hash,
					 const xmlChar *name,
					 const xmlChar *name2);
XMLPUBFUN void *
		xmlHashLookup3		(xmlHashTablePtr hash,
					 const xmlChar *name,
					 const xmlChar *name2,
					 const xmlChar *name3);
XMLPUBFUN void *
		xmlHashQLookup		(xmlHashTablePtr hash,
					 const xmlChar *prefix,
					 const xmlChar *name);
XMLPUBFUN void *
		xmlHashQLookup2		(xmlHashTablePtr hash,
					 const xmlChar *prefix,
					 const xmlChar *name,
					 const xmlChar *prefix2,
					 const xmlChar *name2);
XMLPUBFUN void *
		xmlHashQLookup3		(xmlHashTablePtr hash,
					 const xmlChar *prefix,
					 const xmlChar *name,
					 const xmlChar *prefix2,
					 const xmlChar *name2,
					 const xmlChar *prefix3,
					 const xmlChar *name3);

/*
 * Helpers.
 */
XMLPUBFUN xmlHashTablePtr
		xmlHashCopySafe		(xmlHashTablePtr hash,
					 xmlHashCopier copy,
					 xmlHashDeallocator dealloc);
XMLPUBFUN xmlHashTablePtr
		xmlHashCopy		(xmlHashTablePtr hash,
					 xmlHashCopier copy);
XMLPUBFUN int
		xmlHashSize		(xmlHashTablePtr hash);
XMLPUBFUN void
		xmlHashScan		(xmlHashTablePtr hash,
					 xmlHashScanner scan,
					 void *data);
XMLPUBFUN void
		xmlHashScan3		(xmlHashTablePtr hash,
					 const xmlChar *name,
					 const xmlChar *name2,
					 const xmlChar *name3,
					 xmlHashScanner scan,
					 void *data);
XMLPUBFUN void
		xmlHashScanFull		(xmlHashTablePtr hash,
					 xmlHashScannerFull scan,
					 void *data);
XMLPUBFUN void
		xmlHashScanFull3	(xmlHashTablePtr hash,
					 const xmlChar *name,
					 const xmlChar *name2,
					 const xmlChar *name3,
					 xmlHashScannerFull scan,
					 void *data);
#ifdef __cplusplus
}
#endif
#endif /* ! __XML_HASH_H__ */
