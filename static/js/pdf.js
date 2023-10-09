function openAndDownloadPDF(pdflink) {
    const split = pdflink.split("/")
    window.open(pdflink)
    var link = document.createElement("a")
    link.href = pdflink
    link.download = split[split.length - 1]
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    delete link
}