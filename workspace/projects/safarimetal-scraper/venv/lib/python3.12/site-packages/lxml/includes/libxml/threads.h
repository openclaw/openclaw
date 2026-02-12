/**
 * Summary: interfaces for thread handling
 * Description: set of generic threading related routines
 *              should work with pthreads, Windows native or TLS threads
 *
 * Copy: See Copyright for the status of this software.
 *
 * Author: Daniel Veillard
 */

#ifndef __XML_THREADS_H__
#define __XML_THREADS_H__

#include <libxml/xmlversion.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * xmlMutex are a simple mutual exception locks.
 */
typedef struct _xmlMutex xmlMutex;
typedef xmlMutex *xmlMutexPtr;

/*
 * xmlRMutex are reentrant mutual exception locks.
 */
typedef struct _xmlRMutex xmlRMutex;
typedef xmlRMutex *xmlRMutexPtr;

XMLPUBFUN int
			xmlCheckThreadLocalStorage(void);

XMLPUBFUN xmlMutexPtr
			xmlNewMutex	(void);
XMLPUBFUN void
			xmlMutexLock	(xmlMutexPtr tok);
XMLPUBFUN void
			xmlMutexUnlock	(xmlMutexPtr tok);
XMLPUBFUN void
			xmlFreeMutex	(xmlMutexPtr tok);

XMLPUBFUN xmlRMutexPtr
			xmlNewRMutex	(void);
XMLPUBFUN void
			xmlRMutexLock	(xmlRMutexPtr tok);
XMLPUBFUN void
			xmlRMutexUnlock	(xmlRMutexPtr tok);
XMLPUBFUN void
			xmlFreeRMutex	(xmlRMutexPtr tok);

/*
 * Library wide APIs.
 */
XML_DEPRECATED
XMLPUBFUN void
			xmlInitThreads	(void);
XMLPUBFUN void
			xmlLockLibrary	(void);
XMLPUBFUN void
			xmlUnlockLibrary(void);
XML_DEPRECATED
XMLPUBFUN void
			xmlCleanupThreads(void);

/** DOC_DISABLE */
#if defined(LIBXML_THREAD_ENABLED) && defined(_WIN32) && \
    defined(LIBXML_STATIC_FOR_DLL)
int
xmlDllMain(void *hinstDLL, unsigned long fdwReason,
           void *lpvReserved);
#endif
/** DOC_ENABLE */

#ifdef __cplusplus
}
#endif


#endif /* __XML_THREADS_H__ */
