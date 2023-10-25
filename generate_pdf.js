const puppeteer = require('puppeteer');
const fs = require("fs")
const path = require("path");
const Queue = require("queue-promise")
const toml = require("toml")

const localhost = "http://localhost:1313/"
const config = toml.parse(fs.readFileSync("./hugo.toml", 'utf-8'))
const host = config.baseURL

/**
 * Generates a PDF using jsPDF through a Puppeteer headless browser
 * @param {puppeteer.Browser} browser - Puppeteer Browser
 * @param {string} pagePath - relative path of the page from which the script will generate the PDF
 * @param {string} type - type of PDF to generate, one of ["mode", "module", "unite"]. If any other value is used, no PDF will be generated.
 * @returns {puppeteer.BrowserContext} The context created and used to generate the PDF. Used to be closed later.
 */
async function generatePDF(browser, pagePath, type) {

    /* Creating new BrowserContext and opening page */
    const context = await browser.createIncognitoBrowserContext()
    const page = await context.newPage()
    page.on('console', msg => console.log('PAGE ' + pagePath + ': ', msg.text()))
    /* Navigate to page */
    await page.goto(localhost + pagePath, {waitUntil: 'domcontentloaded'})
    await page.setViewport({width: 1920, height: 1080})

    /* Setting up destination folder */
    const client = await page.target().createCDPSession()
    const dest = 'pdf/' + pagePath
    if (!fs.existsSync(path.join(__dirname, dest))) fs.mkdirSync(dest, {recursive: true})
    await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: dest,
    })

    /* Loading page */
    const dom = await page.$eval('html', element => {
        return element.innerHTML
    })
    await page.setContent(dom)

    /* Generate PDF */
    try {
        await page.evaluate(async ([path, type, host, localhost]) => {

            const {jsPDF} = window.jspdf

            /* PDF generation settings */
            const savingDelay = 1500 // Time to wait in ms before assuming document is saved
            const imgWriteDelay = 500 // Time to wait in ms before assuming image is written in PDF

            /* PDF layout */
            const marginTop = 60
            const marginBot = 30
            const marginLeft = 20
            const marginRight = marginLeft
            const pageEpsilon = 2 // Epsilon to calculate left space on page when displaying sections in pdf
            const margins = [marginTop, marginRight, marginBot, marginLeft]
            const options = {
                orientation: "p",
                unit: "px",
                format: "a4",
                margin: margins,
                compress: true
            }

            /* Image sources */
            const hesImgPath = "/images/logo_hesso_bw.svg"
            const heigImgPath = "/images/logo-heig-21-fr.svg"

            /* Footer */
            const infos = "T +41 (0)24 557 63 30\ninfo@heig-vd.ch"
            const footerFontSize = 7

            /* Header */
            const imgYmargin = 10
            const hesImgLoaded = new Promise(resolve => {
                $.get(hesImgPath, function(data) {
                    const svg = new XMLSerializer().serializeToString(data.documentElement)
                    const img = document.createElement('img');
                    img.src = 'data:image/svg+xml;base64,' + window.btoa(svg);
                    img.onload = function () {
                        const canvas = document.createElement('canvas');
                        canvas.width = img.width;
                        canvas.height = img.height;
                        canvas.getContext('2d').drawImage(img, 0, 0, img.width, img.height);
                        const imgData = canvas.toDataURL('image/png', 1.0);
                        resolve([imgData, img.width, img.height])
                    }
                });
            })
            const heigImgLoaded = new Promise(resolve => {
                $.get(heigImgPath, function(data) {
                    const svg = new XMLSerializer().serializeToString(data.documentElement)
                    const img = document.createElement('img');
                    img.src = 'data:image/svg+xml;base64,' + window.btoa(svg);
                    img.onload = function () {
                        const canvas = document.createElement('canvas');
                        canvas.width = img.width;
                        canvas.height = img.height;
                        canvas.getContext('2d').drawImage(img, 0, 0, img.width, img.height);
                        const imgData = canvas.toDataURL('image/png', 1.0);
                        resolve([imgData, img.width, img.height])
                    }
                });
            })

            /* Unvalidated modules page */
            const sectionBoxMargin = 2
            const sectionBoxColor = "#6495ed"
            const sectionFontSize = 10
            const modulesNameFontSize = 8
            const sectionSpacingY = 10

            /* Hyperlinks injection */
            const linkShiftX = 0.5
            let linkShiftY = - 1;
            const pageAnchorShiftX = 2

            /* Other settings */
            const interLine = 3

            /* ------------------------- Utils ------------------------- */

            /**
             * Generate a list of objects containing the relative position within content,
             * hyperlink and if the link is a module header of every links present in the content.
             * This function is used to render hyperlinks and PDF anchors in the final documents.
             * @param {Element} content - The Elements containing the contents wanted in the PDF
             * @returns {Object[]} List of objects describing the links
             */
            function getLinksRelativeCoords(content) {
                const links = content.querySelectorAll(".pdf-link")
                const contentBRect = content.getBoundingClientRect()
                let linksCoords = []
                for (let i = 0; i < links.length; i++) {
                    const link = links[i]
                    const linkBRect = link.getBoundingClientRect()
                    const url = link.href.replace(localhost, host + "/")
                    linksCoords.push({
                        x: linkBRect.left - contentBRect.left,
                        yTop: linkBRect.top - contentBRect.top,
                        yBot: linkBRect.bottom - contentBRect.top,
                        w: linkBRect.right - linkBRect.left,
                        h: linkBRect.bottom - linkBRect.top,
                        text: link.innerHTML,
                        url: url,
                        moduleHeader: (link.className).includes("module-header")
                    })
                }
                return linksCoords
            }

            /* ------------------------- Header and footer ------------------------- */
            /**
             * Adds the page number to every page footer
             * @param {jsPDF} doc - jsPDF document to write in
             */
            function addPageNumberToDoc(doc) {
                return new Promise(resolve => {
                    const nPages = doc.internal.getNumberOfPages()
                    for (let i = 1; i <= nPages; i++) {
                        doc.setPage(i)
                        doc.setFont(undefined, "normal").text(`${i} / ${nPages}`, marginLeft, doc.internal.pageSize.getHeight() - marginBot / 2, {baseline: "bottom"})
                    }
                    resolve("Added page number to PDF")
                })
            }

            /**
             * Adds footer the document specified page.
             * @param {jsPDF} doc - jsPDF document to write in
             * @param {Number} pageNumber - The number of the page where the footer should be added
             */
            function pageFooter(doc, pageNumber) {
                doc.setPage(pageNumber)
                const footerY = doc.internal.pageSize.getHeight() - marginBot / 2
                doc.setFontSize(footerFontSize)
                let footerX = (doc.internal.pageSize.getWidth() - marginLeft - marginRight) / 2 - doc.getTextWidth(infos) / 2
                doc.text(infos, footerX, footerY, {baseline: "bottom"})
                return new Promise(resolve => {
                    hesImgLoaded.then(([imgDataURL, width, height]) => {
                        doc.setPage(pageNumber)
                        const imgHeight = marginBot - 2 * imgYmargin
                        const imgWidth = width * imgHeight / height
                        footerX = doc.internal.pageSize.getWidth() - marginRight - imgWidth
                        doc.addImage(imgDataURL, "PNG", footerX, footerY - imgHeight / 2, imgWidth, imgHeight, undefined, 'FAST')
                        setTimeout(() => {
                            resolve("Added footer to PDF on page " + pageNumber)
                        }, imgWriteDelay)
                    })
                })
            }

            /**
             * Adds header the document specified page.
             * @param {jsPDF} doc - jsPDF document to write in
             * @param {Number} pageNumber - The number of the page where the header should be added
             * @param {string} headerTitle - The title of the header
             */
            function pageHeader(doc, pageNumber, headerTitle) {
                doc.setPage(pageNumber)
                const headerY = imgYmargin
                let headerX = marginLeft
                return new Promise(resolve => {
                        heigImgLoaded.then(([imgDataURL, width, height]) => {
                            doc.setPage(pageNumber)
                            const imgHeight = marginTop - 2 * imgYmargin
                            const imgWidth = width * imgHeight / height
                            doc.addImage(imgDataURL, "PNG", headerX, headerY, imgWidth, imgHeight, undefined, 'FAST')
                            headerX += doc.internal.pageSize.getWidth() - marginLeft - 2 * marginRight - doc.getTextWidth(headerTitle)
                            doc.setFont(undefined, "bold").text(headerTitle, headerX, headerY, {baseline: "top"})
                            setTimeout(() => {
                                resolve("Added header to PDF on page " + pageNumber)
                            }, imgWriteDelay)
                        })
                    }
                )
            }

            /**
             * Adds header and footer the document specified page.
             * @param {jsPDF} doc - jsPDF document to write in
             * @param {Number} pageNumber - The number of the page where the header and footer should be added
             * @param {string} headerTitle - The title of the header
             */
            function pageHeaderFooter(doc, pageNumber, headerTitle) {
                return new Promise(resolve => {
                    const tasks = [pageFooter(doc, pageNumber), pageHeader(doc, pageNumber, headerTitle)]
                    Promise.all(tasks).then(_ => {
                        resolve("Added header and footer to PDF on page " + pageNumber)
                    })
                })
            }

            /**
             * Adds header and footer the document specified range of pages.
             * @param {jsPDF} doc - jsPDF document to write in
             * @param {*} startPage - First page on which header and footer should be added
             * @param {*} endPage - Last page on which header and footer should be added
             * @param {*} headerTitle - The title of the header
             */
            function addHeaderFooterToDoc(doc, startPage, endPage, headerTitle) {
                let tasks = []
                for (let i = startPage; i <= endPage; i++) {
                    tasks.push(pageHeaderFooter(doc, i, headerTitle))
                }
                return new Promise(resolve => {
                    Promise.all(tasks).then(_ => {
                        resolve("Added header and footer to PDF on pages " + startPage + " to " + endPage)
                    })
                })
            }

            /* ------------------------- PDF sections population ------------------------- */
            /**
             * Adds all contents to PDF document on a specified page and position. Each piece of
             * content shall not be split on multiple pages.
             * One shall verifiy that each content can fit in one page.
             * @param {Element[]} contents - All contents to be added to the PDF.
             * @param {jsPDF} doc - jsPDF document to write in
             * @param {Number} pageY - The Y cords where to start the Rendering
             * @param {Number} pageNumber - The page on which the content shall be placed
             * @param {Promise<any>} resolve - A promise to resolve when all the contents is added to the PDF document.
             */
            function addContentsToPDF(contents, doc, pageY, pageNumber, resolve) {
                if (contents.length < 1) {
                    resolve("Added all sections to PDF")
                    return
                }
                const content = contents.at(0)
                const contentHeight = content.clientHeight
                const pageContentWidth = doc.internal.pageSize.getWidth() - (marginLeft + marginRight)
                const pageContentHeight = doc.internal.pageSize.getHeight() - (marginTop + marginBot)
                const scale = pageContentWidth / content.clientWidth
                let nextY = pageY
                if (pageY + contentHeight * scale >= pageContentHeight - pageEpsilon) {
                    doc.addPage()
                    pageNumber++
                    pageY = 0
                    nextY = contentHeight * scale
                } else {
                    nextY = pageY + contentHeight * scale
                }
                doc.html(content, {
                    html2canvas: {
                        allowTaint: true,
                        logging: false,
                        useCORS: true,
                        scale: scale,
                        removeContainer: true,
                        width: content.clientWidth,
                        height: content.clientHeight,
                        windowWidth: pageContentWidth
                    },
                    y: (pageNumber - 1) * pageContentHeight + pageY,
                    margin: margins,
                    callback: function (doc) {
                        /* Adding hyperlinks */
                        const links = getLinksRelativeCoords(content)
                        for (let i = 0; i < links.length; i++) {
                            const link = links[i]
                            const linkX = marginLeft + link.x * scale
                            const linkY = marginTop + pageY + link.yTop * scale
                            doc.link(linkX + linkShiftX, linkY, link.w * scale, link.h * scale, {url: link.url})
                        }
                        /* Clearing unwanted blankpages */
                        const nPages = doc.internal.getNumberOfPages()
                        if (nPages > pageNumber) {
                            for (let i = nPages; i > pageNumber; i--) {
                                doc.deletePage(i)
                            }
                        }
                        addContentsToPDF(contents.slice(1), doc, nextY, pageNumber, resolve)
                    }
                })
            }

            /**
             * Add content to PDF. Content is first split down in sections using the selectors
             * argument and then added to the PDF using the addContentsToPDF function.
             * The selectors are used to prevent pieces of content to be split on multiples pages.
             * @param {Element} content - The content to be added to PDF
             * @param {string[]} selectors - Selectors to split down content in different sections.
             * @param {jsPDF} doc - jsPDF document to write in
             * @param {Number} pageNumber - The first page on which the content should be rendered
             * @returns {Promise<any>} a promise resolved when all sections are added to PDF
             */
            function generateSectionsPDF(content, selectors, doc, pageNumber) {
                /*
                Getting content to be render by section (A section shall not
                be split on multiple page)
                */
                let sections = []
                for (let i = 0; i < selectors.length; i++) {
                    const targetContent = content.querySelector(selectors.at(i))
                    sections.push(targetContent)
                }
                return new Promise(resolve => {
                    addContentsToPDF(sections, doc, 0, pageNumber, resolve)
                })
            }

            /* ------------------------- PDF generation ------------------------- */

            /**
             * Generates the PDF of a module in document starting at specified page
             * @param {Element} content - The content to add to PDF
             * @param {jsPDF} doc - jsPDF document to write in
             * @param {Number} pageNumber - The first page on which module should be added
             * @returns {Promise<any>} a promise resolved when module is added to PDF
             */
            function generateModulePDF(content, doc, pageNumber) {
                let selectors = [
                    ".module-titre",
                    ".module-titre-infos",
                    ".module-intitule",
                    ".module-organisation",
                    ".module-prerequis",
                    ".module-objectifs",
                    ".module-enseignements",
                    ".module-evaluation",
                    ".module-remediation",
                    ".module-remarques",
                    ".module-bibliographie"
                ]
                return generateSectionsPDF(content, selectors, doc, pageNumber)
            }

            /**
             * Creates and saves PDF file of module description
             * @param {string} module - Name of the module
             * @returns {Promise<any>} A promise resolved when file is saved
             */
            function modulePDF(module) {
                const filename = `${module}.pdf`
                const doc = new jsPDF(options)
                return new Promise(resolve => {
                    const content = document.querySelector(".pdf-content")
                    if (content) {
                        generateModulePDF(content, doc, 1).then(_ => {
                            const tasks = [addHeaderFooterToDoc(doc, 1, doc.internal.getNumberOfPages(), "Descriptif de module"),
                            addPageNumberToDoc(doc)]
                            Promise.all(tasks).then(_ => {
                                doc.save(filename, {returnPromise: true}).then(_ => {
                                    setTimeout(_ => {
                                        resolve()
                                    }, savingDelay)
                                })
                            })
                        })
                    } else {
                        console.warn(`Module ${module} is not validated yet`)
                        resolve()
                    }

                })
            }

            /**
             * Generates the PDF of a unit in document starting at specified page
             * @param {Element} content - The content to add to PDF
             * @param {jsPDF} doc - jsPDF document to write in
             * @param {Number} pageNumber - The first page on which unit should be added
             * @returns {Promise<any>} a promise resolved when unit is added to PDF
             */
            function generateUnitPDF(content, doc, pageNumber) {
                let selectors = [
                    ".unit-title",
                    ".unit-general-infos",
                    ".unit-periods",
                    ".unit-periods-table",
                    ".unit-objectives",
                    ".unit-prior-knowledge",
                    ".unit-content",
                    ".unit-bibliography",
                    ".unit-controls"
                ]
                return generateSectionsPDF(content, selectors, doc, pageNumber)
            }

            /**
             * Creates and saves PDF file of unit sheet
             * @param {string} unit - Name of the unit
             * @returns {Promise<any>} A promise resolved when file is saved
             */
            function unitPDF(unit) {
                const filename = `${unit}.pdf`
                const doc = new jsPDF(options)
                return new Promise(resolve => {
                    const content = document.querySelector(".pdf-content")
                    if (content) {
                        generateUnitPDF(content, doc, 1).then(_ => {
                            const tasks = [addHeaderFooterToDoc(doc, 1, doc.internal.getNumberOfPages(), "Fiche d'unité"),
                            addPageNumberToDoc(doc)]
                            Promise.all(tasks).then(_ => {
                                doc.save(filename, {returnPromise: true}).then(_ => {
                                    setTimeout(_ => {
                                        resolve()
                                    }, savingDelay)
                                })
                            })
                        })
                    } else {
                        console.warn(`Unit ${unit} is not validated yet`)
                        resolve()
                    }
                })
            }

            /**
             * Generates modules planning and adds it to PDF document.
             * @param {jsPDF} doc - jsPDF document to write in
             * @returns {Promise<Object[]>} A promise resolving with a list of
             * every module link (filtered list of links) in the planning. Used
             * later to add page anchors to PDF and last page of PDF (unvalidated modules).
             */
            function generateModulesPlanningPDF(doc) {


                /* Extracting original planning */
                const planning = document.querySelector(".modules-planning")
                const modulesRows = planning.children

                /* Getting all links */
                const links = getLinksRelativeCoords(planning)
                let moduleHeaders = []
                let linksIndex = 0

                /* Adding each subtable of planning to offside div, allowing html2canvas to render it */
                let splitTableDiv = document.createElement("div")
                splitTableDiv.style = `visibility: hidden; position: fixed; right: -10000px; top: -10000px; border: 0px;`
                document.body.appendChild(splitTableDiv)
                let newDiv = document.createElement("div")
                splitTableDiv.appendChild(newDiv)
                let table = document.createElement("table")
                table.className = "table modules-planning"
                newDiv.appendChild(table)

                /* Doc constants */
                const pageContentWidth = doc.internal.pageSize.getWidth() - (marginLeft + marginRight)
                const pageContentHeight = doc.internal.pageSize.getHeight() - (marginTop + marginBot)
                const scale = pageContentWidth / planning.clientWidth

                function newDivTable() {
                    newDiv = document.createElement("div")
                    splitTableDiv.appendChild(newDiv)
                    table = document.createElement("table")
                    table.className = "table modules-planning"
                    table.style.width = `${planning.clientWidth}px`
                    newDiv.appendChild(table)
                }

                for (let i = 0; i < modulesRows.length; i++) {
                    /* Header and body of module table should not be split on 2 pages */
                    if (i < modulesRows.length - 1) {
                        const header = modulesRows[i]
                        const body = modulesRows[i + 1]
                        const totalHeight = (header.clientHeight + body.clientHeight) * scale
                        let currentHeight = splitTableDiv.lastChild.clientHeight * scale
                        if (currentHeight + totalHeight >= pageContentHeight - pageEpsilon) {
                            newDivTable()
                        }
                        splitTableDiv.lastChild.firstChild.appendChild(header.cloneNode(true))
                        splitTableDiv.lastChild.firstChild.appendChild(body.cloneNode(true))
                        i++
                    } else {
                        /* Last element is always total periods row */
                        const totalRow = modulesRows[i]
                        const height = totalRow.clientHeight * scale
                        let currentHeight = splitTableDiv.lastChild.clientHeight * scale
                        if (currentHeight + height >= pageContentHeight - pageEpsilon) {
                            newDivTable()
                        }
                        splitTableDiv.lastChild.firstChild.appendChild(totalRow.cloneNode(true))
                    }
                }
                /* Rendering caption at last */
                const caption = document.querySelector(".caption")
                const captionHeight = caption.clientHeight * scale
                let currentHeight = splitTableDiv.lastChild.clientHeight * scale
                if (currentHeight + captionHeight >= pageContentHeight - pageEpsilon) {
                    newDiv = document.createElement("div")
                    splitTableDiv.appendChild(newDiv)
                }
                splitTableDiv.lastChild.appendChild(caption)

                /**
                 *
                 * @param {Element[]} pages - All the pages to add to PDF
                 * @param {Number} pageNumber - First page on which pages should be added
                 * @param {Promise<any>} resolve - A promise to be resolved when all pages are added
                 */
                function addPages(pages, pageNumber, resolve) {
                    if (pages.length < 1) {
                        const nPages = doc.internal.getNumberOfPages()
                        addHeaderFooterToDoc(doc, 1, nPages, "Programme de formation")
                        resolve(moduleHeaders)
                        return
                    }
                    const page = pages.at(0)
                    doc.addPage()
                    doc.html(page, {
                        html2canvas: {
                            allowTaint: true,
                            useCORS: true,
                            logging: false,
                            scale: scale,
                            removeContainer: true
                        },
                        y: (pageNumber - 1) * pageContentHeight,
                        margin: margins,
                        callback: function (doc) {
                            /* Adding links */
                            const nLinks = page.querySelectorAll(".pdf-link").length
                            for (let i = 0; i < nLinks; i++) {
                                const link = links[i + linksIndex]
                                const linkX = marginLeft + link.x * scale + linkShiftX
                                const linkY = marginTop + (link.yBot - links[linksIndex].yBot + link.h) * scale + linkShiftY
                                doc.link(linkX, linkY, link.w * scale, link.h * scale, {url: link.url})
                                if (link.moduleHeader) {
                                    moduleHeaders.push({
                                        x: linkX,
                                        y: linkY,
                                        w: link.w * scale,
                                        text: link.text,
                                        page: pageNumber
                                    })
                                }
                            }
                            /* Clearing unwanted blankpages */
                            const nPages = doc.internal.getNumberOfPages()
                            if (nPages > pageNumber) {
                                for (let i = nPages; i > pageNumber; i--) {
                                    doc.deletePage(i)
                                }
                            }
                            linksIndex += nLinks
                            addPages(pages.slice(1), ++pageNumber, resolve)
                        }
                    })
                }

                return new Promise(resolve => {
                    addPages(Array.prototype.slice.call(splitTableDiv.children), 1, resolve)
                })
            }

            /**
             * Creates and saves formation booklet as PDF
             * @param {string} formation - Name of the formation
             */
            function generateFormationBooklet(formation) {

                const filename = `${formation}.pdf`
                const doc = new jsPDF(options)

                let unvalidatedModules = []
                let modulesPage = []
                let headerFooterTasks = []

                const modules = Array.prototype.slice.call(document.querySelectorAll(".module-cell a"))

                /* Adding a new div to document body to allow rendering of html from modules pages */
                let remoteContentDiv = document.createElement("div")
                remoteContentDiv.style = "visibility: hidden; position: fixed; left: -10000px; top: -10000px; border: 0px;"
                document.body.appendChild(remoteContentDiv)
                return new Promise(resolvePDF => {
                    /* Adding planning first */
                    generateModulesPlanningPDF(doc).then(modulesCoords => {
                        new Promise(resolveModules => {
                            /**
                             *
                             * @param {Element[]} modules - All modules contained in formation programm.
                             * Elements must have a href atrtibute from which module content shall be
                             * retrieved using JQuery.
                             * @param {Promise<any>} resolve - A promise to be resolved when all modules
                             * content are added to PDF
                             */
                            function addModulesToPDF(modules, resolve) {
                                if (modules.length < 1) {
                                    resolve("Added modules to PDF")
                                    return
                                }
                                /* Getting module content from link */
                                $.get(modules.at(0).href, function (data) {
                                    /* Extracting content */
                                    const moduleName = modules.at(0).innerHTML
                                    const content = $(data).find(".pdf-content")[0]
                                    /* Validated module */
                                    if (content) {
                                        remoteContentDiv.appendChild(content)
                                        remoteContentDiv.style.width = `${content.clientWidth}px`
                                        doc.addPage()
                                        const startPage = doc.internal.getNumberOfPages()
                                        modulesPage.push({name: moduleName, page: startPage})
                                        generateModulePDF(content, doc, startPage).then(_ => {
                                            headerFooterTasks.push(addHeaderFooterToDoc(doc, startPage, doc.internal.getNumberOfPages(), "Descriptif de module"))
                                            remoteContentDiv.removeChild(content)
                                            addModulesToPDF(modules.slice(1), resolve)
                                        })
                                    } else /* Module not yet validated or error occured */ {
                                        unvalidatedModules.push(modules.at(0).innerText)
                                        addModulesToPDF(modules.slice(1), resolve)
                                        modulesPage.push({name: moduleName, page: -1})
                                    }
                                })
                            }
                            addModulesToPDF(modules, resolveModules)
                        }).then(_ => {
                            /* Once all modules are added to PDF */
                            document.body.removeChild(remoteContentDiv)
                            if (unvalidatedModules.length > 0) {
                                doc.addPage()
                                const nPages = doc.internal.getNumberOfPages()
                                headerFooterTasks.push(pageHeaderFooter(doc, nPages, "Descriptif de module"))
                                const boxWidth = doc.internal.pageSize.getWidth() - (marginLeft + marginTop)
                                const boxHeight = 2 * sectionBoxMargin * 2 + sectionFontSize
                                let currY = marginTop
                                doc.setFillColor(sectionBoxColor).rect(marginLeft, currY, boxWidth, boxHeight, "F")
                                doc.setFontSize(sectionFontSize)
                                    .setFont(undefined, "bold")
                                    .text("Liste des descriptifs de module actuellement indisponibles", marginLeft + sectionBoxMargin, currY + 6 * sectionBoxMargin)
                                currY += boxHeight + sectionSpacingY
                                doc.setFontSize(modulesNameFontSize).setFont(undefined, "normal")
                                for (let i = 0; i < unvalidatedModules.length; i++) {
                                    doc.text(`- ${unvalidatedModules.at(i)}`, marginLeft, currY)
                                    currY += modulesNameFontSize + interLine
                                }


                                /* Adding modules description pages to modules planning */
                                for (let i = 0; i < modulesPage.length; i++) {
                                    const mod = modulesPage[i]
                                    let page = mod.page
                                    if (page === -1) {
                                        page = nPages
                                    }
                                    const coords = modulesCoords.filter(m => m.text.includes(mod.name)).at(0)
                                    doc.setPage(coords.page)
                                    doc.textWithLink("§", coords.x + coords.w + pageAnchorShiftX, coords.y + 2, {pageNumber: page})
                                }
                            }
                            headerFooterTasks.push(addPageNumberToDoc(doc))
                            Promise.all(headerFooterTasks).then(_ => {
                                doc.save(filename, {returnPromise: true}).then(_ => {
                                    setTimeout(() => resolvePDF(), savingDelay)
                                })
                            })

                        })
                    })
                })
            }

            const split = path.split('/')
            switch (type) {
                case "mode":
                    await generateFormationBooklet(split[split.length - 2] + "-" + split[split.length - 1])
                    return
                case "module":
                    await modulePDF(split[split.length - 1])
                    return
                case "unite":
                    await unitPDF(split[split.length - 1])
                    return
                default:
            }
        }, [pagePath, type, host, localhost])
        return context
    } catch (err) {
        console.info(err)
        return context
    }
}

const modes = []
const modules = []
const unites = []
const topFolder = "public"

/**
 * Retrieves the list of modules and units from every specified paths.
 * This script writes in the global variables modules and unites
 * @param {string[]} folderPaths - Source Paths
 * @param {Number} depth - The current depth from source paths. Assuming that 1
 * indicates the function is at modules level and 2 units level.
 */
function listModulesUnits(folderPaths, depth) {
    folderPaths.forEach(folderPath => {
        const results = fs.readdirSync(folderPath)
        const folders = results.filter(res => fs.lstatSync(path.resolve(folderPath, res)).isDirectory())
        const innerFolderPaths = folders.map(folder => path.resolve(folderPath, folder))
        if (depth === 1) modules.push(path.relative(topFolder, folderPath))
        if (depth === 2) unites.push(path.relative(topFolder, folderPath))
        if (innerFolderPaths.length === 0) return
        listModulesUnits(innerFolderPaths, depth + 1)
    })
}

/**
 * Retrieves the list of formation programms, modules and units from every specified paths
 * This script writes in the global variables modes, modules and unites
 * @param {string[]} folderPaths - Source Paths
 */
function listFolders(folderPaths) {
    folderPaths.forEach(folderPath => {
        const results = fs.readdirSync(folderPath)
        const folders = results.filter(res => fs.lstatSync(path.resolve(folderPath, res)).isDirectory())
        const innerFolderPaths = folders.map(folder => path.resolve(folderPath, folder))
        if (innerFolderPaths.length === 0) return
        if (!(folderPath.endsWith("/pt") || folderPath.endsWith("/tp-ee"))) listFolders(innerFolderPaths)
        else {
            modes.push(path.relative(topFolder, folderPath))
            listModulesUnits(innerFolderPaths, 1)
        }
    })
}

/**
 * Pads a number to 2 digits
 * @param {Number} num - Number to be pad
 * @returns {String} padded number
 */
function padTo2Digits(num) {
    return num.toString().padStart(2, '0');
}

/**
 * Convert milliseconds in human friendly time range
 * @param {Number} milliseconds - Number of millisecond to process
 * @returns {string} formated time range string
 */
function msToHMS(milliseconds) {
    let seconds = Math.floor(milliseconds / 1000);
    let minutes = Math.floor(seconds / 60);
    let hours = Math.floor(minutes / 60);

    seconds = seconds % 60;
    minutes = minutes % 60;

    hours = hours % 24;

    return `${padTo2Digits(hours)}:${padTo2Digits(minutes)}:${padTo2Digits(
        seconds,
    )}`;
}

/* PDF parallel Scrapping settings */
const maxParallelBookletGeneration = 2
const maxParallelDescriptionGeneration = 5
const maxParallelSheetGeneration = 5

const browserClosingDelay = 1000
const devServerDelay = 5000

/**
 * Generates all the PDF from the public folder (containing hugo site pages)
 */
function run() {
    listFolders([path.resolve(__dirname, topFolder)], 0)
    setTimeout(() => {
        puppeteer.launch({headless: "new" }).then(browser => {
            const start = performance.now()
            const queueBooklets = new Queue({
                concurrent: maxParallelBookletGeneration,
                interval: 0
            })
            queueBooklets.enqueue(modes.map(x => {
                return async () => {
                    const context = await generatePDF(browser, x, "mode")
                    await context.close()
                }
            }))
            queueBooklets.on("reject", (err) => {
                console.info(err)
            })
            queueBooklets.on("end", () => {
                const moduleStart = performance.now()
                console.info("Generated formation booklets in ", msToHMS(moduleStart - start))
                const queueDescriptions = new Queue({
                    concurrent: maxParallelDescriptionGeneration,
                    interval: 0
                })
                queueDescriptions.enqueue(modules.map(x => {
                    return async () => {
                        const context = await generatePDF(browser, x, "module")
                        await context.close()
                    }
                }))
                queueDescriptions.on("reject", (err) => {
                    console.info(err)
                })
                queueDescriptions.on("end", () => {
                    const unitStart = performance.now()
                    console.info("Generated module descriptions in ", msToHMS(unitStart - moduleStart))
                    const queueSheets = new Queue({
                        concurrent: maxParallelSheetGeneration,
                        interval: 0
                    })
                    queueSheets.enqueue(unites.map(x => {
                        return async () => {
                            const context = await generatePDF(browser, x, "unite")
                            await context.close()
                        }
                    }))
                    queueSheets.on("reject", (err) => {
                        console.info(err)
                    })
                    queueSheets.on("end", () => {
                        const end = performance.now()
                        console.info("Generated unit sheets in ", msToHMS(end - unitStart))
                        setTimeout(() => {
                            console.info("Closing browser...")
                            console.info("Generated PDF files in ", msToHMS(end - start))
                            browser.close().then()
                        }, browserClosingDelay)
                    })
                    queueSheets.start()
                })
                queueDescriptions.start()
            })
            queueBooklets.start()
        })
    }, devServerDelay)
}

run()
