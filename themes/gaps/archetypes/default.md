---
title: "{{ replace .Name "-" " " | title }}"
draft: false
menu:
  main:
    identifier: "{{ lower (replace .Name "-" "")  }}"
    weight: 100 
    parent: ""
cascade:
  banner: images/banner_heig-vd.svg
---

<h1> {{ .Name }} </h1>