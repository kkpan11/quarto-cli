function Pandoc(doc)
  quarto.format.is_asciidoc_output()
  quarto.format.is_latex_output()
  quarto.format.is_beamer_output()
  quarto.format.is_docx_output()
  quarto.format.is_rtf_output()
  quarto.format.is_odt_output()
  quarto.format.is_word_processor_output()
  quarto.format.is_powerpoint_output()
  quarto.format.is_revealjs_output()
  quarto.format.is_slide_output()
  quarto.format.is_epub_output()
  quarto.format.is_github_markdown_output()
  quarto.format.is_hugo_markdown_output()
  quarto.format.is_markdown_output()
  quarto.format.is_markdown_with_html_output()
  quarto.format.is_ipynb_output()
  quarto.format.is_html_output()
  quarto.format.is_html_slide_output()
  quarto.format.is_bibliography_output()
  quarto.format.is_native_output()
  quarto.format.is_json_output()
  quarto.format.is_ast_output()
  quarto.format.is_jats_output()
  quarto.format.is_typst_output()
  quarto.format.is_confluence_output()
  quarto.format.is_docusaurus_output()
  quarto.format.is_dashboard_output()
  quarto.format.is_email_output()
  quarto.format.parse_format("html")
end