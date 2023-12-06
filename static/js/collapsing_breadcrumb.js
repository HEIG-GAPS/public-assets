jQuery(function () {
    jQuery(".breadcrumb:not(.no-collapse-breadcrumb)").map(function (idx, breadcrumb) {
      var breadcrumb = jQuery(breadcrumb);
      
      if (breadcrumb.children().length > 4) {
        var detached_children = breadcrumb.children().slice(1, -1).detach();
        
        var expand_breadcrumb = jQuery('<li class="breadcrumb-item"><a href="" title="Show all breadcrumbs"><strong>...</strong></a></li>');
        var collapse_breadcrumb = jQuery('<li class="ps-1 d-flex align-content-center"><a href="" title="Collapse breadcrumbs"> <i class="align-middle fa-solid fa-circle-chevron-up fa-rotate-270"></i> </a></li>');

        function collapse(event) {
          event.preventDefault();
          detached_children.remove();
          collapse_breadcrumb.remove();
          breadcrumb.children().first().after(expand_breadcrumb);
          expand_breadcrumb.on("click", expand);
        }

        function expand(event) {
          event.preventDefault();
          breadcrumb.children().slice(1, -1).remove();
          breadcrumb.children().first().after(detached_children);
          breadcrumb.children().last().after(collapse_breadcrumb);
          collapse_breadcrumb.on("click", collapse);
        }

        expand_breadcrumb.on("click", expand);

        breadcrumb.children().first().after(expand_breadcrumb);
      }
    }); 
  });

