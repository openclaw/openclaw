/*
 * Summary: macros for marking symbols as exportable/importable.
 *
 * Copy: See Copyright for the status of this software.
 */

#ifndef __EXSLT_EXPORTS_H__
#define __EXSLT_EXPORTS_H__

#if defined(_WIN32) || defined(__CYGWIN__)
/** DOC_DISABLE */

#ifdef LIBEXSLT_STATIC
  #define EXSLTPUBLIC
#elif defined(IN_LIBEXSLT)
  #define EXSLTPUBLIC __declspec(dllexport)
#else
  #define EXSLTPUBLIC __declspec(dllimport)
#endif

#define EXSLTCALL __cdecl

/** DOC_ENABLE */
#else /* not Windows */

/**
 * EXSLTPUBLIC:
 *
 * Macro which declares a public symbol
 */
#define EXSLTPUBLIC

/**
 * EXSLTCALL:
 *
 * Macro which declares the calling convention for exported functions
 */
#define EXSLTCALL

#endif /* platform switch */

/*
 * EXSLTPUBFUN:
 *
 * Macro which declares an exportable function
 */
#define EXSLTPUBFUN EXSLTPUBLIC

/**
 * EXSLTPUBVAR:
 *
 * Macro which declares an exportable variable
 */
#define EXSLTPUBVAR EXSLTPUBLIC extern

/* Compatibility */
#if !defined(LIBEXSLT_PUBLIC)
#define LIBEXSLT_PUBLIC EXSLTPUBVAR
#endif

#endif /* __EXSLT_EXPORTS_H__ */


